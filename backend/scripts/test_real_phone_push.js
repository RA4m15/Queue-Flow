const mongoose = require('mongoose');
const User = require('../src/models/User');
const { fcmAdapter } = require('../src/channels/fcmAdapter');
require('dotenv').config();

async function testPush() {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOne({ email: 'shiva@gmail.com' });
  if (!user || !user.fcmToken) {
    console.error('User or FCM token not found for shiva@gmail.com');
    await mongoose.disconnect();
    return;
  }

  console.log('Sending test push to device token:', user.fcmToken.slice(0, 15) + '...');
  const result = await fcmAdapter.sendPush({
    token: user.fcmToken,
    title: 'Your token is approaching',
    body: 'Your token C-023 is approaching. Please be ready.',
    data: {
      type: 'TOKEN_APPROACHING',
      tokenId: 'test-token-123',
    },
  });

  console.log('Delivery result:', result);
  await mongoose.disconnect();
}

testPush().catch(console.error);
