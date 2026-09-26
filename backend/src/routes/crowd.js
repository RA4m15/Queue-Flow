'use strict';

const router = require('express').Router();
const { getCrowd, getHistory } = require('../controllers/crowdController');
const { validateObjectId } = require('../middleware/validate');

// Public — customer app shows crowd before joining
router.get('/:centerId', validateObjectId('centerId'), getCrowd);
router.get('/:centerId/history', validateObjectId('centerId'), getHistory);

module.exports = router;
