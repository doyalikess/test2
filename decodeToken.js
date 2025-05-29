// Load environment variables from .env file
require('dotenv').config();

const jwt = require('jsonwebtoken');

// Your token (replace this with the token you want to decode)
const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2ODM0NzA1NzFhZGVkZTI1YjQxMTQzMGEiLCJpYXQiOjE3NDgyNjkzNTcsImV4cCI6MTc0ODg3NDE1N30.PHejWFzQg7IT5o8ICgwZcF5AtRDWXldCCTXDS71gLA4";

// Get the secret from environment variable
const secret = process.env.JWT_SECRET;

try {
  // Decode and verify the JWT token using the secret key
  const decoded = jwt.verify(token, secret);

  // Print the decoded JWT payload to the console
  console.log('Decoded JWT:', decoded);

  // Access the userId from the decoded token
  const userId = decoded.userId;
  console.log('User ID:', userId);  // This userId can be used to find the user in the database

} catch (err) {
  console.error('Error decoding token:', err);
}
