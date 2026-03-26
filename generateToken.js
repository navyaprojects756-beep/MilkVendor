require("dotenv").config()
const jwt = require("jsonwebtoken")

const vendorId = "1009524062248491"

const token = jwt.sign(
  { vendorId },
  "mysecretkey",   // must match JWT_SECRET in .env
  { expiresIn: "2h" }
)

console.log("TOKEN:\n", token)

console.log("\nURL:\n")
console.log(`${process.env.APP_BASE_URL}?token=${token}`)