'use strict';

const ServiceCenter = require('../models/ServiceCenter');
const FootfallEvent = require('../models/FootfallEvent');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendNotFound } = require('../utils/apiResponse');
const { emitToCenter } = require('../config/socket');

/**
 * GET /api/crowd/:centerId
 * Get current crowd for a service center.
 */
const getCrowd = asyncHandler(async (req, res) => {
  const center = await ServiceCenter.findById(req.params.centerId)
    .select('name currentCrowd crowdUpdatedAt capacity capacityAlertThreshold')
    .lean({ virtuals: true });

  if (!center) return sendNotFound(res, 'Service center not found');

  // A reading is only trustworthy while the sensor is still reporting.
  const SENSOR_STALE_MS = 90000;
  const crowdUpdatedAt = center.crowdUpdatedAt || null;
  const crowdSensorOnline = Boolean(
    crowdUpdatedAt && (Date.now() - new Date(crowdUpdatedAt).getTime()) < SENSOR_STALE_MS
  );

  return sendSuccess(res, {
    data: {
      centerId: center._id,
      name: center.name,
      currentCrowd: center.currentCrowd,
      capacity: center.capacity,
      crowdPercent: center.crowdPercent,
      crowdStatus: center.crowdStatus,
      capacityAlertThreshold: center.capacityAlertThreshold,
      crowdUpdatedAt,
      crowdSensorOnline,
    },
  });
});

/**
 * GET /api/crowd/:centerId/history
 * Get recent footfall events for trending charts.
 */
const getHistory = asyncHandler(async (req, res) => {
  let limitNum = parseInt(req.query.limit, 10);
  if (isNaN(limitNum) || limitNum < 1) limitNum = 50;
  if (limitNum > 200) limitNum = 200;

  let hoursNum = parseInt(req.query.hours, 10);
  if (isNaN(hoursNum) || hoursNum < 1) hoursNum = 8;
  if (hoursNum > 168) hoursNum = 168;

  const since = new Date(Date.now() - hoursNum * 60 * 60 * 1000);

  const events = await FootfallEvent.find({
    centerId: req.params.centerId,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(limitNum)
    .lean();

  return sendSuccess(res, { data: { events } });
});

module.exports = { getCrowd, getHistory };
