'use strict';

/**
 * queueMetricsService
 * ───────────────────
 * SINGLE AUTHORITATIVE SOURCE for center-scoped live queue metrics.
 *
 * Why this exists
 * ---------------
 * `Queue.waitingCount` / `Queue.completedCount` are day-partitioned counters
 * (`{ centerId, serviceId, date }`). They are correct for "today's queue" but
 * they are NOT the current state of the floor:
 *
 *   • a center that has not yet created a Queue document for today reports
 *     `waitingCount = 0` even while real WAITING tokens exist in the collection;
 *   • a token that joined before midnight is still WAITING but is counted in
 *     yesterday's partition.
 *
 * Token documents are the source of truth for "who is in the building right
 * now". Every live surface (Admin Panel stat pills, Live Counter board,
 * analytics dashboard) must therefore read its counts from here, so there is
 * exactly one definition of "waiting" and exactly one measured wait average.
 *
 * Definitions (all center-scoped):
 *   waitingCount    — Token.status === 'WAITING'
 *   servingCount    — Token.status ∈ { 'CALLED', 'SERVING' }
 *   completedToday  — Token.status === 'COMPLETED' AND completedAt falls in
 *                     today's local day. Waiting / CALLED / SERVING / CANCELLED /
 *                     SKIPPED / EXPIRED are never counted as completed.
 *   issuedToday     — Token.createdAt falls in today's local day
 *   avgWaitSeconds  — MEASURED average of (calledAt − createdAt) over tokens
 *                     that ARRIVED today and have since been called. This is
 *                     the same measurement the historical analytics endpoint
 *                     already performs, so no second wait-time formula is
 *                     introduced. It is `null` — never a fabricated number —
 *                     until at least one of today's arrivals has actually been
 *                     called.
 *   waitSampleCount — how many real measurements back avgWaitSeconds, so the
 *                     UI can be truthful about how much history exists.
 */

const mongoose = require('mongoose');
const { Token } = require('../models/Token');

/** Statuses that mean "physically in the building, not yet finished". */
const ACTIVE_STATUSES = ['CALLED', 'SERVING'];

/**
 * Local-time boundaries for "today", aligned with getTodayDateString() which
 * partitions Queue documents by the server's local calendar day.
 * @returns {{ start: Date, end: Date }}
 */
function getLocalDayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * Authoritative live queue metrics for one service center.
 *
 * @param {string|import('mongoose').Types.ObjectId} centerId
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{
 *   centerId: string,
 *   waitingCount: number,
 *   servingCount: number,
 *   completedToday: number,
 *   issuedToday: number,
 *   avgWaitSeconds: number|null,
 *   waitSampleCount: number,
 *   measuredAt: string
 * }>}
 */
async function getLiveQueueMetrics(centerId, options = {}) {
  const now = options.now || new Date();
  const { start, end } = getLocalDayRange(now);
  const centerKey = String(centerId);

  // `Token.find()` / `countDocuments()` cast a string id to ObjectId via the
  // schema, but `aggregate()` does NOT. Passing the raw string here would match
  // nothing and silently report every count as 0, so cast explicitly.
  const centerObjectId =
    centerId instanceof mongoose.Types.ObjectId ? centerId : new mongoose.Types.ObjectId(centerKey);

  const [statusCounts, completedToday, issuedToday, waitAgg] = await Promise.all([
    // Current floor state — not day-partitioned, so a token that joined before
    // midnight is still counted while it is genuinely still waiting.
    Token.aggregate([
      { $match: { centerId: centerObjectId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Token.countDocuments({
      centerId: centerObjectId,
      status: 'COMPLETED',
      completedAt: { $gte: start, $lt: end },
    }),
    Token.countDocuments({ centerId: centerObjectId, createdAt: { $gte: start, $lt: end } }),
    // Measured wait, defined exactly as the historical endpoint defines it
    // (calledAt − createdAt).
    //
    // Cohort = tokens that ARRIVED today (createdAt within today's local day)
    // and have since actually been called. Cohorting on arrival rather than on
    // call time matters: a token that joined yesterday and was only called
    // today would otherwise drag today's "average wait" to a multi-hour figure
    // that no customer in the building today experienced.
    //
    // With no such token the result is null — the truthful "not enough real
    // data yet" state — never a fabricated or carried-over number.
    Token.aggregate([
      {
        $match: {
          centerId: centerObjectId,
          createdAt: { $gte: start, $lt: end },
          calledAt: { $ne: null },
        },
      },
      {
        $project: {
          waitTimeSeconds: {
            $divide: [{ $subtract: ['$calledAt', '$createdAt'] }, 1000],
          },
        },
      },
      { $match: { waitTimeSeconds: { $gte: 0 } } },
      {
        $group: {
          _id: null,
          avgWaitSeconds: { $avg: '$waitTimeSeconds' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byStatus = new Map();
  for (const row of statusCounts) {
    byStatus.set(row._id, row.count);
  }

  const waitingCount = byStatus.get('WAITING') || 0;
  const servingCount = ACTIVE_STATUSES.reduce((sum, s) => sum + (byStatus.get(s) || 0), 0);

  const waitRow = waitAgg[0];
  const waitSampleCount = waitRow ? waitRow.count : 0;
  const avgWaitSeconds = waitRow ? Math.round(waitRow.avgWaitSeconds) : null;

  return {
    centerId: centerKey,
    waitingCount,
    servingCount,
    completedToday,
    issuedToday,
    avgWaitSeconds,
    waitSampleCount,
    measuredAt: now.toISOString(),
  };
}

module.exports = {
  ACTIVE_STATUSES,
  getLocalDayRange,
  getLiveQueueMetrics,
};
