const jwt = require("jsonwebtoken")
require("dotenv").config()

function generateVendorToken(vendorId, role = "admin") {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing")
  }
  return jwt.sign(
    { vendorId, role },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  )
}

function verifyVendorToken(token) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing")
  }
  return jwt.verify(token, process.env.JWT_SECRET)
}

module.exports = { generateVendorToken, verifyVendorToken }
