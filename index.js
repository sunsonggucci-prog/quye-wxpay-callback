const express = require('express')
const crypto = require('crypto')

const app = express()

app.use(express.text({ type: '*/*' }))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

const TOKEN = 'QYVirtualPay2026'

function checkSignature(signature, timestamp, nonce) {
  const arr = [TOKEN, timestamp, nonce].sort()
  const str = arr.join('')
  const sha1 = crypto.createHash('sha1').update(str).digest('hex')
  return sha1 === signature
}

app.get('/', (req, res) => {
  res.status(200).send('quye wxpay callback service running')
})

app.get('/wx/callback', (req, res) => {
  try {
    const { signature, timestamp, nonce, echostr } = req.query || {}
    console.log('GET /wx/callback query =', req.query)

    if (checkSignature(signature, timestamp, nonce)) {
      return res.status(200).send(echostr || '')
    }
    return res.status(401).send('signature check failed')
  } catch (err) {
    console.error('GET /wx/callback error =', err)
    return res.status(500).send('server error')
  }
})

app.post('/wx/callback', (req, res) => {
  try {
    const { signature, timestamp, nonce } = req.query || {}
    console.log('POST /wx/callback query =', req.query)
    console.log('POST /wx/callback body =', req.body)

    if (!checkSignature(signature, timestamp, nonce)) {
      return res.status(401).send('signature check failed')
    }

    return res.status(200).send('success')
  } catch (err) {
    console.error('POST /wx/callback error =', err)
    return res.status(500).send('server error')
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection =', reason)
})

process.on('uncaughtException', (err) => {
  console.error('uncaughtException =', err)
})

const port = process.env.PORT || 80
app.listen(port, () => {
  console.log(`Express app listening on port ${port}`)
})
