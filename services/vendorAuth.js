const jwt = require("jsonwebtoken")
require("dotenv").config()

function generateVendorToken(vendorId, role = "admin") {
  return jwt.sign(
    { vendorId, role },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  )
}

function verifyVendorToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

module.exports = { generateVendorToken, verifyVendorToken }