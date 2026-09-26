'use strict';

const router = require('express').Router();
const { iotSecret } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { handleRfid, handleCrowd, scanQR, rfidValidation, crowdValidation, scanQRValidation } = require('../controllers/iotController');

// All IoT endpoints require the shared IoT device secret (x-iot-secret header)
router.use(iotSecret);

router.post('/rfid', rfidValidation, validate, handleRfid);
router.post('/crowd', crowdValidation, validate, handleCrowd);
// QR scan verification endpoint for physical scanner hardware (ESP32, kiosk, etc.)
router.post('/scan-qr', scanQRValidation, validate, scanQR);

module.exports = router;

