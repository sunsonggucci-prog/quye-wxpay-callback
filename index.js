const express = require('express')
const crypto = require('crypto')

const app = express()

app.use(express.text({ type: '*/*' }))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

const TOKEN = 'QYVirtualPay2026'

// 微信验签
function checkSignature(signature, timestamp, nonce) {
  const arr = [TOKEN, timestamp, nonce].sort()
  const str = arr.join('')
  const sha1 = crypto.createHash('sha1').update(str).digest('hex')
  return sha1 === signature
}

// 根路径，方便你测试服务是否活着
app.get('/', (req, res) => {
  res.send('quye wxpay callback service running')
})

// 微信消息推送：首次验证 URL
app.get('/wx/callback', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query

  console.log('GET /wx/callback query =', req.query)

  if (checkSignature(signature, timestamp, nonce)) {
    return res.status(200).send(echostr)
  }

  return res.status(401).send('signature check failed')
})

// 微信消息推送：后续事件推送
app.post('/wx/callback', (req, res) => {
  const { signature, timestamp, nonce } = req.query

  console.log('POST /wx/callback query =', req.query)
  console.log('POST /wx/callback body =', req.body)

  if (!checkSignature(signature, timestamp, nonce)) {
    return res.status(401).send('signature check failed')
  }

  // 先只返回 success，后面等你确认推送内容后再接发货逻辑
  return res.status(200).send('success')
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`Express app listening on port ${port}`)
})
