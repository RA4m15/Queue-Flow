'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const {
  getDashboard,
  getTokenTimeSeries,
  getOperationalOverview,
  getWaitTimeIntelligence,
  getHistoricalReport,
  exportHistoricalReport,
  getDemandAndStaffingForecast,
  getCenterWorkload,
  getOperatorWorkloads,
  getMyWorkload,
  getWorkloadRecommendations,
} = require('../controllers/analyticsController');

// Analytics require authentication
router.use(protect);

// Resource Hub Centralized Overview & Historical Reporting (ADMIN only)
router.get('/:centerId/operational-overview', requireRole('ADMIN'), validateObjectId('centerId'), getOperationalOverview);
// Tier 3 / Feature 1 — Context-Aware EWT explainability (ADMIN only)
router.get('/:centerId/ewt', requireRole('ADMIN'), validateObjectId('centerId'), getWaitTimeIntelligence);
// Tier 3 / Feature 2 — ML Footfall & Staffing Predictor (ADMIN only)
router.get('/:centerId/forecast', requireRole('ADMIN'), validateObjectId('centerId'), getDemandAndStaffingForecast);
router.get('/:centerId/historical', requireRole('ADMIN'), validateObjectId('centerId'), getHistoricalReport);
router.get('/:centerId/historical/export', requireRole('ADMIN'), validateObjectId('centerId'), exportHistoricalReport);

// Tier 4 / Feature 5 — Cognitive Load / Workload Balancer Endpoints
router.get('/:centerId/workload/me', requireRole('STAFF', 'ADMIN'), validateObjectId('centerId'), getMyWorkload);
router.get('/:centerId/workload/operators', requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getOperatorWorkloads);
router.get('/:centerId/workload/recommendations', requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getWorkloadRecommendations);
router.get('/:centerId/workload', requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getCenterWorkload);

// General Dashboard & Time-series (ADMIN and STAFF)
router.get('/:centerId', requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getDashboard);
router.get('/:centerId/tokens', requireRole('ADMIN', 'STAFF'), validateObjectId('centerId'), getTokenTimeSeries);

module.exports = router;
