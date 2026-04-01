const express = require('express')
const crypto = require('crypto')
const xml2js = require('xml2js')
const cloud = require('wx-server-sdk')

const app = express()

// 必须和小程序后台「消息推送配置」里的 Token 完全一致
const CALLBACK_TOKEN = 'QYVirtualPay2026'

cloud.init({
  env: process.env.CLOUDBASE_ENV || process.env.TCB_ENV || cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

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

  if (!bodyText) return null

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

async function invokeGrantVirtualPack(outTradeNo, productId) {
  const res = await cloud.callFunction({
    name: 'grantVirtualPack',
    data: {
      outTradeNo,
      productId
    }
  })

  const result = (res && res.result) || {}
  console.log('grantVirtualPack result =', JSON.stringify(result))

  if (result.success || result.duplicated) {
    return result
  }

  throw new Error(`grantVirtualPack failed: ${JSON.stringify(result)}`)
}

// 可选：异步记账，不阻塞主发货链路
async function upsertOrderSnapshot(payload) {
  try {
    const outTradeNo = payload.OutTradeNo || ''
    const openid = payload.OpenId || ''
    const env = Number(payload.Env || 0)
    const goodsInfo = payload.GoodsInfo || {}
    const wxPayInfo = payload.WeChatPayInfo || {}

    if (!outTradeNo) return

    const productId = goodsInfo.ProductId || ''
    const packCountMap = { pack_5: 5, pack_11: 11, pack_24: 24 }
    const packCount = packCountMap[productId] || 0

    const orderCollection = db.collection('xpay_orders')

    const orderRes = await orderCollection.where({
      outTradeNo
    }).limit(1).get()

    if (!orderRes.data || orderRes.data.length === 0) {
      await orderCollection.add({
        data: {
          outTradeNo,
          openid,
          env,
          productId,
          buyQuantity: Number(goodsInfo.Quantity || 1),
          packCount,
          status: 'PAID',
          granted: true,
          grantedAt: Date.now(),
          transactionId: wxPayInfo.TransactionId || '',
          mchOrderNo: wxPayInfo.MchOrderNo || '',
          paidTime: Number(wxPayInfo.PaidTime || 0),
          actualPrice: Number(goodsInfo.ActualPrice || 0),
          origPrice: Number(goodsInfo.OrigPrice || 0),
          attach: goodsInfo.Attach || '',
          pushPayload: payload,
          createdFrom: 'callback_direct_grant',
          updatedAt: Date.now(),
          createdAt: Date.now()
        }
      })
      console.log('upsertOrderSnapshot add ok, outTradeNo =', outTradeNo)
      return
    }

    const order = orderRes.data[0]
    await orderCollection.doc(order._id).update({
      data: {
        status: 'PAID',
        granted: true,
        grantedAt: Date.now(),
        transactionId: wxPayInfo.TransactionId || order.transactionId || '',
        mchOrderNo: wxPayInfo.MchOrderNo || order.mchOrderNo || '',
        paidTime: Number(wxPayInfo.PaidTime || order.paidTime || 0),
        actualPrice: Number(goodsInfo.ActualPrice || order.actualPrice || 0),
        origPrice: Number(goodsInfo.OrigPrice || order.origPrice || 0),
        attach: goodsInfo.Attach || order.attach || '',
        pushPayload: payload,
        updatedAt: Date.now()
      }
    })
    console.log('upsertOrderSnapshot update ok, outTradeNo =', outTradeNo)
  } catch (err) {
    console.error('upsertOrderSnapshot error =', err)
  }
}

async function handleGoodsDeliverNotify(payload) {
  const outTradeNo = payload.OutTradeNo || ''
  const goodsInfo = payload.GoodsInfo || {}
  const productId = goodsInfo.ProductId || ''

  if (!outTradeNo) {
    throw new Error('xpay_goods_deliver_notify missing OutTradeNo')
  }

  if (!productId) {
    throw new Error('xpay_goods_deliver_notify missing ProductId')
  }

  // 先直接发货 —— 这是主链路
  const grantResult = await invokeGrantVirtualPack(outTradeNo, productId)

  // 再异步记账 —— 这是附属链路
  upsertOrderSnapshot(payload)

  console.log('handleGoodsDeliverNotify done, outTradeNo =', outTradeNo)
  return grantResult
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
      return res.type('application/xml').send(xmlFail('payload empty'))
    }

    console.log('POST /wx/callback parsed payload =', JSON.stringify(payload))

    const eventName = payload.Event || ''
    console.log('POST /wx/callback eventName =', eventName)

    if (!eventName) {
      console.error('POST /wx/callback Event empty')
      return res.type('application/xml').send(xmlFail('event empty'))
    }

    switch (eventName) {
      case 'xpay_goods_deliver_notify':
        await handleGoodsDeliverNotify(payload)
        return res.type('application/xml').send(xmlSuccess())

      case 'xpay_refund_notify':
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
    // 发货失败，不回 success，让微信继续重推
    return res.type('application/xml').send(xmlFail('server error'))
  }
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`server started on ${port}`)
})
