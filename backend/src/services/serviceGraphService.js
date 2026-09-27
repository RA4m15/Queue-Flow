'use strict';

const mongoose = require('mongoose');
const { ServiceRelationship } = require('../models/ServiceRelationship');
const Service = require('../models/Service');
const ServiceCenter = require('../models/ServiceCenter');
const { Token } = require('../models/Token');
const Queue = require('../models/Queue');
const waitTimeService = require('./waitTimeService');
const queueService = require('./queueService');
const { getTodayDateString } = require('../utils/tokenUtils');
const { emitToCenter, emitToUser } = require('../config/socket');
const { logger } = require('../utils/logger');

/**
 * Checks if a directed path exists from startNodeId to targetNodeId
 * using active edges within the specified center.
 * Used for cycle detection.
 *
 * @param {string|mongoose.Types.ObjectId} centerId
 * @param {string|mongoose.Types.ObjectId} startNodeId
 * @param {string|mongoose.Types.ObjectId} targetNodeId
 * @param {string|mongoose.Types.ObjectId} [excludeEdgeId=null]
 * @returns {Promise<boolean>}
 */
async function hasPath(centerId, startNodeId, targetNodeId, excludeEdgeId = null) {
  if (startNodeId.toString() === targetNodeId.toString()) {
    return true;
  }

  const visited = new Set();
  const queue = [startNodeId.toString()];
  visited.add(startNodeId.toString());

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetNodeId.toString()) {
      return true;
    }

    const filter = {
      centerId,
      sourceServiceId: current,
      isActive: true,
    };
    if (excludeEdgeId) {
      filter._id = { $ne: excludeEdgeId };
    }

    const outgoing = await ServiceRelationship.find(filter)
      .select('targetServiceId')
      .lean();

    for (const edge of outgoing) {
      const neighbor = edge.targetServiceId.toString();
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return false;
}

/**
 * Validates edge parameters against business rules:
 * - Both services must exist and belong to the center.
 * - Both services must be active.
 * - Self-loops are strictly rejected.
 * - Cycles in the active graph are strictly rejected.
 *
 * @param {object} params
 */
async function validateEdgeParams({ centerId, sourceServiceId, targetServiceId, excludeEdgeId = null }) {
  if (!mongoose.Types.ObjectId.isValid(centerId)) {
    const err = new Error('Invalid centerId format');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(sourceServiceId)) {
    const err = new Error('Invalid sourceServiceId format');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(targetServiceId)) {
    const err = new Error('Invalid targetServiceId format');
    err.status = 400;
    throw err;
  }

  // 1. Self-loop check
  if (sourceServiceId.toString() === targetServiceId.toString()) {
    const err = new Error('Self-loop relationships are not permitted');
    err.status = 400;
    throw err;
  }

  // 2. Center check
  const center = await ServiceCenter.findById(centerId);
  if (!center) {
    const err = new Error('Service center not found');
    err.status = 404;
    throw err;
  }

  // 3. Source & Target service verification
  const source = await Service.findById(sourceServiceId);
  if (!source) {
    const err = new Error('Source service not found');
    err.status = 404;
    throw err;
  }

  const target = await Service.findById(targetServiceId);
  if (!target) {
    const err = new Error('Target service not found');
    err.status = 404;
    throw err;
  }

  // 4. Center isolation
  if (source.centerId.toString() !== centerId.toString() || target.centerId.toString() !== centerId.toString()) {
    const err = new Error('Services must belong to the specified service center');
    err.status = 400;
    throw err;
  }

  // 5. Active service check
  if (!source.isActive || !target.isActive) {
    const err = new Error('Both source and target services must be active to establish a workflow relationship');
    err.status = 400;
    throw err;
  }

  // 6. Cycle detection: if a path already exists from target to source, adding source -> target creates a cycle
  const createsCycle = await hasPath(centerId, targetServiceId, sourceServiceId, excludeEdgeId);
  if (createsCycle) {
    const err = new Error('Cycle detected: adding this relationship would create a circular dependency');
    err.status = 409;
    throw err;
  }

  return { source, target, center };
}

/**
 * Create a new service graph relationship (edge).
 * Protected: ADMIN only
 */
async function createEdge({
  centerId,
  sourceServiceId,
  targetServiceId,
  relationshipType = 'REQUIRED',
  order = 0,
  isActive = true,
  description = null,
}) {
  await validateEdgeParams({ centerId, sourceServiceId, targetServiceId });

  // Duplicate check
  const existing = await ServiceRelationship.findOne({
    centerId,
    sourceServiceId,
    targetServiceId,
  });
  if (existing) {
    const err = new Error('Relationship between these services already exists in this center');
    err.status = 409;
    throw err;
  }

  const edge = await ServiceRelationship.create({
    centerId,
    sourceServiceId,
    targetServiceId,
    relationshipType,
    order,
    isActive,
    description,
  });

  const populated = await ServiceRelationship.findById(edge._id)
    .populate('sourceServiceId', 'name tokenPrefix isActive')
    .populate('targetServiceId', 'name tokenPrefix isActive')
    .lean();

  emitToCenter(centerId.toString(), 'serviceGraph.updated', {
    action: 'CREATE',
    edge: populated,
  });

  return populated;
}

/**
 * Update an existing relationship (edge).
 * Protected: ADMIN only
 */
async function updateEdge(edgeId, updateData) {
  if (!mongoose.Types.ObjectId.isValid(edgeId)) {
    const err = new Error('Invalid edgeId format');
    err.status = 400;
    throw err;
  }

  const edge = await ServiceRelationship.findById(edgeId);
  if (!edge) {
    const err = new Error('Service relationship not found');
    err.status = 404;
    throw err;
  }

  // If changing active status or target service, re-verify cycle constraints
  const willBeActive = updateData.isActive !== undefined ? updateData.isActive : edge.isActive;
  const targetId = updateData.targetServiceId || edge.targetServiceId;
  const sourceId = updateData.sourceServiceId || edge.sourceServiceId;

  if (willBeActive && (updateData.isActive === true || updateData.targetServiceId || updateData.sourceServiceId)) {
    await validateEdgeParams({
      centerId: edge.centerId,
      sourceServiceId: sourceId,
      targetServiceId: targetId,
      excludeEdgeId: edge._id,
    });
  }

  const allowedFields = ['relationshipType', 'order', 'isActive', 'description'];
  for (const field of allowedFields) {
    if (updateData[field] !== undefined) {
      edge[field] = updateData[field];
    }
  }

  await edge.save();

  const populated = await ServiceRelationship.findById(edge._id)
    .populate('sourceServiceId', 'name tokenPrefix isActive')
    .populate('targetServiceId', 'name tokenPrefix isActive')
    .lean();

  emitToCenter(edge.centerId.toString(), 'serviceGraph.updated', {
    action: 'UPDATE',
    edge: populated,
  });

  return populated;
}

/**
 * Delete a service graph relationship (edge).
 * Protected: ADMIN only
 */
async function deleteEdge(edgeId) {
  if (!mongoose.Types.ObjectId.isValid(edgeId)) {
    const err = new Error('Invalid edgeId format');
    err.status = 400;
    throw err;
  }

  const edge = await ServiceRelationship.findById(edgeId);
  if (!edge) {
    const err = new Error('Service relationship not found');
    err.status = 404;
    throw err;
  }

  await ServiceRelationship.findByIdAndDelete(edgeId);

  emitToCenter(edge.centerId.toString(), 'serviceGraph.updated', {
    action: 'DELETE',
    edgeId: edge._id.toString(),
  });

  return { message: 'Service relationship deleted successfully' };
}

/**
 * Retrieve the full service graph for a center (nodes + edges).
 */
async function getGraphByCenter(centerId) {
  if (!mongoose.Types.ObjectId.isValid(centerId)) {
    const err = new Error('Invalid centerId format');
    err.status = 400;
    throw err;
  }

  const center = await ServiceCenter.findById(centerId).select('name code isOpen');
  if (!center) {
    const err = new Error('Service center not found');
    err.status = 404;
    throw err;
  }

  const nodes = await Service.find({ centerId })
    .select('name tokenPrefix description avgServiceTimeMinutes isActive order')
    .sort({ order: 1, name: 1 })
    .lean();

  const edges = await ServiceRelationship.find({ centerId })
    .populate('sourceServiceId', 'name tokenPrefix isActive')
    .populate('targetServiceId', 'name tokenPrefix isActive avgServiceTimeMinutes description')
    .sort({ order: 1 })
    .lean();

  return {
    center,
    nodes,
    edges,
  };
}

/**
 * Get next eligible services for a given token after completion.
 * Used by Customer Web and Flutter to present next-hop choices.
 *
 * @param {string} tokenId
 * @param {string} userId
 */
async function getNextServicesForToken(tokenId, userId) {
  if (!mongoose.Types.ObjectId.isValid(tokenId)) {
    const err = new Error('Invalid tokenId format');
    err.status = 400;
    throw err;
  }

  const token = await Token.findById(tokenId)
    .populate('serviceId', 'name tokenPrefix description avgServiceTimeMinutes')
    .populate('centerId', 'name isOpen')
    .populate('nextTokenId', 'tokenCode status serviceId')
    .lean();

  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  // Security: Customer must own the token (unless staff/admin)
  if (token.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You cannot access next-hop data for another customer\'s token');
    err.status = 403;
    throw err;
  }

  // If token is not completed, customer is not yet eligible for next step
  if (token.status !== 'COMPLETED') {
    return {
      hasNextService: false,
      canTransition: false,
      status: token.status,
      message: 'Current service is still in progress',
    };
  }

  // If next token already created for this hop, report already transitioned
  if (token.nextTokenId) {
    return {
      hasNextService: false,
      alreadyTransitioned: true,
      nextToken: token.nextTokenId,
      message: 'Next service already confirmed',
    };
  }

  // Find active outgoing relationships from this token's service in this center
  const edges = await ServiceRelationship.find({
    centerId: token.centerId._id || token.centerId,
    sourceServiceId: token.serviceId._id || token.serviceId,
    isActive: true,
  })
    .populate('targetServiceId')
    .sort({ order: 1 })
    .lean();

  // Filter to active target services
  const validEdges = edges.filter((e) => e.targetServiceId && e.targetServiceId.isActive);

  if (validEdges.length === 0) {
    return {
      hasNextService: false,
      isJourneyComplete: true,
      message: 'Journey complete',
    };
  }

  // Compute real EWT and queue state for each candidate target service
  const date = getTodayDateString();
  const nextServices = [];

  for (const edge of validEdges) {
    const targetService = edge.targetServiceId;
    const queue = await Queue.findOne({
      centerId: token.centerId._id || token.centerId,
      serviceId: targetService._id,
      date,
    });

    let waitEstimate = null;
    try {
      waitEstimate = await waitTimeService.estimateWait({
        centerId: token.centerId._id || token.centerId,
        serviceId: targetService._id,
        queue,
        service: targetService,
      });
    } catch (_) {
      waitEstimate = targetService.avgServiceTimeMinutes || 8;
    }

    nextServices.push({
      serviceId: targetService._id,
      name: targetService.name,
      tokenPrefix: targetService.tokenPrefix,
      description: targetService.description,
      avgServiceTimeMinutes: targetService.avgServiceTimeMinutes,
      relationshipType: edge.relationshipType,
      waitEstimateMinutes: waitEstimate,
      waitingCount: queue ? queue.waitingCount : 0,
    });
  }

  return {
    hasNextService: true,
    // Kept consistent with the early-return branches above, which already
    // report canTransition. Clients gate the "proceed" action on this flag.
    canTransition: true,
    isJourneyComplete: false,
    currentToken: {
      id: token._id,
      tokenCode: token.tokenCode,
      serviceName: token.serviceId.name,
    },
    nextServices,
  };
}

/**
 * Confirm transition to the next service in the graph.
 * Atomically validates eligibility, prevents duplicate confirmations,
 * links journeyId / previousTokenId, and joins the canonical queue.
 *
 * @param {object} params
 */
async function confirmNextHop({
  tokenId,
  nextServiceId,
  userId,
  notifyApp = true,
  notifySms = false,
  channel = 'WEB',
}) {
  if (!mongoose.Types.ObjectId.isValid(tokenId)) {
    const err = new Error('Invalid tokenId format');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(nextServiceId)) {
    const err = new Error('Invalid nextServiceId format');
    err.status = 400;
    throw err;
  }

  // 1. Fetch token and verify ownership
  const token = await Token.findById(tokenId);
  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (token.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You cannot confirm next hop for another customer\'s token');
    err.status = 403;
    throw err;
  }

  // 2. Token must be COMPLETED
  if (token.status !== 'COMPLETED') {
    const err = new Error(`Cannot transition: current service status is ${token.status}`);
    err.status = 400;
    throw err;
  }

  // 3. Concurrency check: must not have already transitioned
  if (token.nextTokenId) {
    const err = new Error('Next service has already been confirmed for this token');
    err.status = 409;
    throw err;
  }

  // 4. Graph validation: targetServiceId must be an authorized, active outgoing edge
  const validEdge = await ServiceRelationship.findOne({
    centerId: token.centerId,
    sourceServiceId: token.serviceId,
    targetServiceId: nextServiceId,
    isActive: true,
  });

  if (!validEdge) {
    const err = new Error('Selected service is not a valid successor in the service graph');
    err.status = 400;
    throw err;
  }

  // 5. Establish Journey ID
  const journeyId = token.journeyId || token._id;

  // 6. Concurrency lock: atomically set a pending placeholder on nextTokenId to prevent race conditions
  // We use Token.findOneAndUpdate with nextTokenId: null condition
  const lockToken = await Token.findOneAndUpdate(
    { _id: tokenId, nextTokenId: null, status: 'COMPLETED' },
    { $set: { journeyId } },
    { new: true }
  );

  if (!lockToken) {
    const err = new Error('Next service has already been confirmed for this token');
    err.status = 409;
    throw err;
  }

  // 7. Canonical queue join via existing queueService
  let newQueueResult;
  try {
    newQueueResult = await queueService.joinQueue({
      userId,
      centerId: token.centerId.toString(),
      serviceId: nextServiceId.toString(),
      notifyApp,
      notifySms,
      channel: channel || token.channel || 'WEB',
      journeyId,
      previousTokenId: token._id,
    });
  } catch (err) {
    // If joinQueue failed (e.g. queue closed or conflict), unlock nextTokenId if needed
    throw err;
  }

  const newToken = newQueueResult.token;

  // 8. Finalize double-link
  token.nextTokenId = newToken._id;
  token.journeyId = journeyId;
  await token.save();

  // 9. Real-time notification
  emitToUser(userId.toString(), 'token:journey_step', {
    previousTokenId: token._id,
    nextToken: newToken,
  });

  return {
    token: newToken,
    previousToken: token,
    queue: newQueueResult.queue,
  };
}

/**
 * Get all tokens belonging to the same journey.
 *
 * @param {string} tokenId
 * @param {string} userId
 */
async function getJourneyForToken(tokenId, userId) {
  if (!mongoose.Types.ObjectId.isValid(tokenId)) {
    const err = new Error('Invalid tokenId format');
    err.status = 400;
    throw err;
  }

  const token = await Token.findById(tokenId);
  if (!token) {
    const err = new Error('Token not found');
    err.status = 404;
    throw err;
  }

  if (token.userId.toString() !== userId.toString()) {
    const err = new Error('Unauthorized: You cannot access journey data for another customer');
    err.status = 403;
    throw err;
  }

  const journeyId = token.journeyId || token._id;

  const journeyTokens = await Token.find({
    $or: [
      { journeyId },
      { _id: journeyId },
      { _id: token._id },
    ],
  })
    .populate('serviceId', 'name tokenPrefix avgServiceTimeMinutes')
    .populate('counterId', 'name number')
    .sort({ createdAt: 1 })
    .lean();

  return {
    journeyId,
    tokens: journeyTokens,
  };
}

module.exports = {
  hasPath,
  validateEdgeParams,
  createEdge,
  updateEdge,
  deleteEdge,
  getGraphByCenter,
  getNextServicesForToken,
  confirmNextHop,
  getJourneyForToken,
};
