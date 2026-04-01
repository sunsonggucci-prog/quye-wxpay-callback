const express = require('express')
const crypto = require('crypto')
const xml2js = require('xml2js')
const cloudbase = require('@cloudbase/node-sdk')

const app = express()

// 这里改成你在小程序后台「消息推送配置」里填写的 Token
const CALLBACK_TOKEN = 'QYVirtualPay2026'

const ENV_ID =
  process.env.CLOUDBASE_ENV ||
  process.env.TCB_ENV ||
  process.env.SCF_NAMESPACE ||
  ''

const tcbApp = cloudbase.init({
  env: ENV_ID
})

const db = tcbApp.database()

// 关键：不要让 express 提前按 json/text 解析，统一先吃原始 body
app.use(express.raw({
  type: () => true,
  limit: '2mb'
}))

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex')
}

function checkWechatSignature(signature, timestamp, nonce) {
  const arr = [CALLBACK_TOKEN, timestamp, nonce].sort()
  return sha1(arr.join('')) === signature
}

function xmlSuccess() {
  return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>'
}

function xmlFail(msg = 'fail') {
  return `<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[${msg}]]></ErrMsg></xml>`
}

function normalizeNumber(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function getPackCountByProductId(productId) {
  const map = {
    pack_5: 5,
    pack_11: 11,
    pack_24: 24
  }
  return map[productId] || 0
}

async function parseIncomingBody(req) {
  let rawBuffer

  if (Buffer.isBuffer(req.body)) {
    rawBuffer = req.body
  } else if (typeof req.body === 'string') {
    rawBuffer = Buffer.from(req.body, 'utf8')
  } else if (req.body instanceof Uint8Array) {
    rawBuffer = Buffer.from(req.body)
  } else if (req.body) {
    rawBuffer = Buffer.from(String(req.body), 'utf8')
  } else {
    rawBuffer = Buffer.alloc(0)
  }

  const bodyText = rawBuffer.toString('utf8').trim()

  console.log('POST /wx/callback req.body type =', typeof req.body)
  console.log('POST /wx/callback req.body isBuffer =', Buffer.isBuffer(req.body))
  console.log('POST /wx/callback raw body length =', rawBuffer.length)
  console.log('POST /wx/callback raw body preview =', bodyText.slice(0, 1000))
  console.log('POST /wx/callback raw body base64 preview =', rawBuffer.toString('base64').slice(0, 1000))

  if (!bodyText) {
    return null
  }

  if (bodyText.startsWith('{') || bodyText.startsWith('[')) {
    try {
      return JSON.parse(bodyText)
    } catch (e) {
      console.error('json parse error =', e)
      return null
    }
  }

  if (bodyText.startsWith('<')) {
    try {
      const xmlRes = await xml2js.parseStringPromise(bodyText, {
        explicitArray: false,
        trim: true
      })
      return xmlRes && xmlRes.xml ? xmlRes.xml : xmlRes
    } catch (err) {
      console.error('xml parse error =', err)
      return null
    }
  }

  return null
}

async function markOrderPaidByPush(payload) {
  const outTradeNo = payload.OutTradeNo || ''
  const openid = payload.OpenId || ''
  const env = normalizeNumber(payload.Env, 0)
  const goodsInfo = payload.GoodsInfo || {}
  const wxPayInfo = payload.WeChatPayInfo || {}

  const productId = goodsInfo.ProductId || ''
  const quantity = normalizeNumber(goodsInfo.Quantity, 1)

  if (!outTradeNo) {
    throw new Error('OutTradeNo missing')
  }

  const orderCollection = db.collection('xpay_orders')
  const orderRes = await orderCollection.where({
    outTradeNo
  }).limit(1).get()

  // 推送先到、订单后到的兜底
  if (!orderRes.data || orderRes.data.length === 0) {
    await orderCollection.add({
      outTradeNo,
      openid,
      env,
      productId,
      buyQuantity: quantity,
      packCount: getPackCountByProductId(productId),
      status: 'PAID',
      granted: false,
      transactionId: wxPayInfo.TransactionId || '',
      mchOrderNo: wxPayInfo.MchOrderNo || '',
      paidTime: normalizeNumber(wxPayInfo.PaidTime, 0),
      actualPrice: normalizeNumber(goodsInfo.ActualPrice, 0),
      origPrice: normalizeNumber(goodsInfo.OrigPrice, 0),
      attach: goodsInfo.Attach || '',
      pushPayload: payload,
      createdFrom: 'push_backfill',
      updatedAt: Date.now(),
      createdAt: Date.now()
    })

    console.log('markOrderPaidByPush: order not found, backfill created, outTradeNo =', outTradeNo)
    return
  }

  const order = orderRes.data[0]

  await orderCollection.doc(order._id).update({
    status: 'PAID',
    transactionId: wxPayInfo.TransactionId || order.transactionId || '',
    mchOrderNo: wxPayInfo.MchOrderNo || order.mchOrderNo || '',
    paidTime: normalizeNumber(wxPayInfo.PaidTime, order.paidTime || 0),
    actualPrice: normalizeNumber(goodsInfo.ActualPrice, order.actualPrice || 0),
    origPrice: normalizeNumber(goodsInfo.OrigPrice, order.origPrice || 0),
    attach: goodsInfo.Attach || order.attach || '',
    pushPayload: payload,
    updatedAt: Date.now()
  })

  console.log('markOrderPaidByPush: order updated to PAID, outTradeNo =', outTradeNo)
}

async function markOrderRefundedByPush(payload) {
  const outTradeNo = payload.MchOrderId || ''
  if (!outTradeNo) return

  const orderCollection = db.collection('xpay_orders')
  const orderRes = await orderCollection.where({
    outTradeNo
  }).limit(1).get()

  if (!orderRes.data || orderRes.data.length === 0) {
    console.log('markOrderRefundedByPush: order not found, outTradeNo =', outTradeNo)
    return
  }

  const order = orderRes.data[0]

  await orderCollection.doc(order._id).update({
    status: 'REFUNDED',
    refundPayload: payload,
    updatedAt: Date.now()
  })

  console.log('markOrderRefundedByPush: order updated to REFUNDED, outTradeNo =', outTradeNo)
}

app.get('/', (req, res) => {
  res.send('quye wxpay callback service running')
})

// 配置消息推送时微信会先 GET 校验
app.get('/wx/callback', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query || {}

  console.log('GET /wx/callback query =', req.query)

  if (!signature || !timestamp || !nonce) {
    return res.status(400).send('missing signature params')
  }

  if (!checkWechatSignature(signature, timestamp, nonce)) {
    return res.status(403).send('signature invalid')
  }

  return res.send(echostr || '')
})

// 正式推送入口
app.post('/wx/callback', async (req, res) => {
  try {
    const { signature, timestamp, nonce } = req.query || {}

    console.log('POST /wx/callback query =', req.query)
    console.log('POST /wx/callback headers =', JSON.stringify(req.headers))

    if (!signature || !timestamp || !nonce) {
      console.error('POST /wx/callback missing signature params')
      return res.type('application/xml').send(xmlFail('missing signature params'))
    }

    if (!checkWechatSignature(signature, timestamp, nonce)) {
      console.error('POST /wx/callback signature invalid')
      return res.type('application/xml').send(xmlFail('signature invalid'))
    }

    const payload = await parseIncomingBody(req)

    if (!payload) {
      console.error('POST /wx/callback payload empty')
      // 不回 success，让微信重推
      return res.type('application/xml').send(xmlFail('payload empty'))
    }

    console.log('POST /wx/callback parsed payload =', JSON.stringify(payload))

    const eventName = payload.Event || ''
    console.log('POST /wx/callback eventName =', eventName)

    if (!eventName) {
      console.error('POST /wx/callback Event empty')
      // 不回 success，让微信重推
      return res.type('application/xml').send(xmlFail('event empty'))
    }

    switch (eventName) {
      case 'xpay_goods_deliver_notify':
        await markOrderPaidByPush(payload)
        return res.type('application/xml').send(xmlSuccess())

      case 'xpay_refund_notify':
        await markOrderRefundedByPush(payload)
        return res.type('application/xml').send(xmlSuccess())

      case 'xpay_coin_pay_notify':
      case 'xpay_complaint_notify':
        return res.type('application/xml').send(xmlSuccess())

      default:
        console.error('POST /wx/callback unsupported event =', eventName)
        return res.type('application/xml').send(xmlFail('unsupported event'))
    }
  } catch (err) {
    console.error('POST /wx/callback error =', err)
    return res.type('application/xml').send(xmlFail('server error'))
  }
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`server started on ${port}`)
})
