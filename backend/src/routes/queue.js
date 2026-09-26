'use strict';

const router = require('express').Router();
const {
  getQueueStatus,
  getServiceQueue,
  getCenterDisplay,
  getRecentEvents,
} = require('../controllers/queueController');
const { protect, requireRole } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');

// Public: customers and monitors can see live queue status
router.get('/:centerId', validateObjectId('centerId'), getQueueStatus);
router.get('/:centerId/display', validateObjectId('centerId'), getCenterDisplay);
router.get('/:centerId/:serviceId', validateObjectId('centerId', 'serviceId'), getServiceQueue);

// Admin/Staff only: recent audit log
router.get('/:centerId/events/recent', protect, requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getRecentEvents);

module.exports = router;
