const mongoose = require('mongoose');
const User = require('../src/models/User');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find({
    fcmToken: { $ne: null, $not: /^synthetic-/ }
  }).select('email fcmToken name role');
  console.log('Real phone users with FCM token:', JSON.stringify(users, null, 2));
  await mongoose.disconnect();
}
check();
