const jwt = require("jsonwebtoken")
require("dotenv").config()

function generateVendorToken(vendorId){

 return jwt.sign(
  {vendorId},
  process.env.JWT_SECRET,
  {expiresIn:"2h"}
 )

}

function verifyVendorToken(token){

 return jwt.verify(token,process.env.JWT_SECRET)

}

module.exports={
 generateVendorToken,
 verifyVendorToken
}