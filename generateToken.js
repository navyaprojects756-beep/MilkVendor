const jwt = require("jsonwebtoken")

const vendorId = "1009524062248491"

const token = jwt.sign(
  { vendorId },
  "mysecretkey",   // must match JWT_SECRET in .env
  { expiresIn: "2h" }
)

console.log("TOKEN:\n", token)

console.log("\nURL:\n")
console.log(`http://localhost:3000/vendor-dashboard.html?token=${token}`)