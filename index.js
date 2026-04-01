const express = require('express')
const crypto = require('crypto')
const xml2js = require('xml2js')
const cloudbase = require('@cloudbase/node-sdk')

const app = express()

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

// 关键：统一先按 raw 读取，后面自己解析
app.use(express.raw({
  type: '*/*',
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

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

async function parseIncomingBody(req) {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : ''

  const bodyText = (rawBody || '').trim()

  console.log('POST /wx/callback headers =', JSON.stringify(req.headers))
  console.log('POST /wx/callback raw body text =', bodyText)

  if (!bodyText) {
    return null
  }

  // JSON
  if (bodyText.startsWith('{') || bodyText.startsWith('[')) {
    const jsonObj = tryParseJson(bodyText)
    if (jsonObj) return jsonObj
  }

  // XML
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
  const outTradeNo = payload.OutTradeNo
  const openid = payload.OpenId
  const env = normalizeNumber(payload.Env, 0)
  const goodsInfo = payload.GoodsInfo || {}
  const wxPayInfo = payload.WeChatPayInfo || {}

  const productId = goodsInfo.ProductId || ''
  const quantity = normalizeNumber(goodsInfo.Quantity, 1)

  if (!outTradeNo) {
    throw new Error('OutTradeNo 缺失')
  }

  const orderCollection = db.collection('xpay_orders')
  const orderRes = await orderCollection.where({
    outTradeNo
  }).limit(1).get()

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
      createdFrom: 'push_backfill',
      transactionId: wxPayInfo.TransactionId || '',
      mchOrderNo: wxPayInfo.MchOrderNo || '',
      paidTime: normalizeNumber(wxPayInfo.PaidTime, 0),
      actualPrice: normalizeNumber(goodsInfo.ActualPrice, 0),
      origPrice: normalizeNumber(goodsInfo.OrigPrice, 0),
      attach: goodsInfo.Attach || '',
      pushPayload: payload,
      updatedAt: Date.now(),
      createdAt: Date.now()
    })
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
}

async function markOrderRefundedByPush(payload) {
  const outTradeNo = payload.MchOrderId || ''
  if (!outTradeNo) return

  const orderCollection = db.collection('xpay_orders')
  const orderRes = await orderCollection.where({
    outTradeNo
  }).limit(1).get()

  if (!orderRes.data || orderRes.data.length === 0) return

  const order = orderRes.data[0]
  await orderCollection.doc(order._id).update({
    status: 'REFUNDED',
    refundPayload: payload,
    updatedAt: Date.now()
  })
}

app.get('/', (req, res) => {
  res.send('quye wxpay callback service running')
})

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

app.post('/wx/callback', async (req, res) => {
  try {
    const { signature, timestamp, nonce } = req.query || {}

    console.log('POST /wx/callback query =', req.query)

    if (!signature || !timestamp || !nonce) {
      return res.type('application/xml').send(xmlFail('missing signature params'))
    }

    if (!checkWechatSignature(signature, timestamp, nonce)) {
      return res.type('application/xml').send(xmlFail('signature invalid'))
    }

    const payload = await parseIncomingBody(req)

    if (!payload) {
      console.error('POST /wx/callback payload empty')
      // 关键：这里不能返回 success，要让微信重推
      return res.type('application/xml').send(xmlFail('payload empty'))
    }

    console.log('POST /wx/callback parsed payload =', JSON.stringify(payload))

    const eventName = payload.Event || ''

    if (!eventName) {
      console.error('POST /wx/callback Event empty')
      // 关键：这里也不能返回 success，要让微信重推
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
