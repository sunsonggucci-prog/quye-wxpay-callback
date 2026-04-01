const express = require('express')
const crypto = require('crypto')
const xml2js = require('xml2js')
const cloudbase = require('@cloudbase/node-sdk')

const app = express()

// 这里改成你消息推送配置里用的 Token
const CALLBACK_TOKEN = 'QYVirtualPay2026'

// 云开发环境 ID：优先取系统环境变量
const ENV_ID =
  process.env.CLOUDBASE_ENV ||
  process.env.TCB_ENV ||
  process.env.SCF_NAMESPACE ||
  ''

const tcbApp = cloudbase.init({
  env: ENV_ID
})

const db = tcbApp.database()
const _ = db.command

// 微信消息推送可能发 XML，这里同时支持 text / json / urlencoded
app.use(express.text({ type: ['text/*', 'application/xml', 'application/json', '*/*'] }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex')
}

function checkWechatSignature(signature, timestamp, nonce) {
  const arr = [CALLBACK_TOKEN, timestamp, nonce].sort()
  return sha1(arr.join('')) === signature
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

async function parseIncomingBody(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase()

  if (contentType.includes('application/json')) {
    return req.body || {}
  }

  const bodyText =
    typeof req.body === 'string'
      ? req.body
      : Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : ''

  if (!bodyText) return {}

  if (bodyText.trim().startsWith('{')) {
    return safeJsonParse(bodyText) || {}
  }

  if (bodyText.trim().startsWith('<xml') || bodyText.trim().startsWith('<')) {
    const result = await xml2js.parseStringPromise(bodyText, {
      explicitArray: false,
      trim: true
    })
    return result && result.xml ? result.xml : result
  }

  return {}
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

async function markOrderPaidByPush(payload) {
  const outTradeNo = payload.OutTradeNo
  const openid = payload.OpenId
  const env = normalizeNumber(payload.Env, 0)
  const goodsInfo = payload.GoodsInfo || {}
  const wxPayInfo = payload.WeChatPayInfo || {}

  const productId = goodsInfo.ProductId || ''
  const quantity = normalizeNumber(goodsInfo.Quantity, 1)

  const orderCollection = db.collection('xpay_orders')
  const orderRes = await orderCollection.where({
    outTradeNo
  }).limit(1).get()

  if (!orderRes.data || orderRes.data.length === 0) {
    // 找不到订单也先写一条，避免推送丢失
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

// 微信消息推送首次配置校验
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

// 微信消息推送正式回调
app.post('/wx/callback', async (req, res) => {
  try {
    const { signature, timestamp, nonce } = req.query || {}

    console.log('POST /wx/callback query =', req.query)
    console.log('POST /wx/callback raw body =', req.body)

    if (!signature || !timestamp || !nonce) {
      return res.type('application/xml').send(xmlFail('missing signature params'))
    }

    if (!checkWechatSignature(signature, timestamp, nonce)) {
      return res.type('application/xml').send(xmlFail('signature invalid'))
    }

    const payload = await parseIncomingBody(req)

    console.log('POST /wx/callback parsed payload =', JSON.stringify(payload))

    const eventName = payload.Event || ''

    switch (eventName) {
      case 'xpay_goods_deliver_notify':
        await markOrderPaidByPush(payload)
        return res.type('application/xml').send(xmlSuccess())

      case 'xpay_refund_notify':
        await markOrderRefundedByPush(payload)
        return res.type('application/xml').send(xmlSuccess())

      case 'xpay_coin_pay_notify':
      case 'xpay_complaint_notify':
      default:
        // 先回成功，避免微信重推
        return res.type('application/xml').send(xmlSuccess())
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
