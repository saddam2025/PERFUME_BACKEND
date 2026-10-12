const mongoose = require('mongoose');
const Promotion = require('../models/Promotion');
const Product = require('../models/Product');
const sendControllerError = require('../utils/controllerError');
const { promotionHint } = require('../utils/promotionPricing');

function validatePromotion(payload, product) {
  if (!payload.name?.trim()) return 'Promotion name is required.';
  const types = ['BUY_X_GET_Y_FREE', 'QUANTITY_PERCENT_DISCOUNT', 'QUANTITY_FIXED_DISCOUNT'];
  if (!types.includes(payload.type)) return 'Choose a valid promotion type.';
  if (!Array.isArray(payload.tiers) || !payload.tiers.length) return 'Add at least one promotion tier.';
  for (const tier of payload.tiers) {
    if (!Number.isInteger(Number(tier.minQty)) || Number(tier.minQty) < 1) return 'Minimum quantity must be a positive integer.';
    if (payload.type === 'BUY_X_GET_Y_FREE' && (!Number.isInteger(Number(tier.getQty)) || Number(tier.getQty) < 1)) return 'Free quantity must be a positive integer.';
    if (payload.type === 'QUANTITY_PERCENT_DISCOUNT' && (!Number.isFinite(Number(tier.percent)) || Number(tier.percent) < 1 || Number(tier.percent) > 100)) return 'Percentage must be between 1 and 100.';
    if (payload.type === 'QUANTITY_FIXED_DISCOUNT' && (!Number.isFinite(Number(tier.fixedPrice)) || Number(tier.fixedPrice) < 0 || Number(tier.fixedPrice) >= Number(tier.minQty) * Number(product.price))) return 'Bundle price must be below the regular price of its minimum quantity.';
  }
  const startsAt = new Date(payload.startsAt);
  if (!payload.startsAt || Number.isNaN(startsAt.getTime())) return 'A valid start date is required.';
  if (payload.endsAt && (Number.isNaN(new Date(payload.endsAt).getTime()) || new Date(payload.endsAt) <= startsAt)) return 'End date must be after the start date.';
  return null;
}

const publicList = async (req, res) => {
  try {
    const now = new Date();
    const promotions = await Promotion.find({ isActive: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] })
      .populate({ path: 'product', select: 'nameEn nameAr price imageUrls stock variants' }).sort({ priority: -1, startsAt: -1 });
    const active = promotions.filter((promotion) => promotion.product && Number(promotion.product.stock) > 0)
      .map((promotion) => ({ ...promotion.toObject(), hint: promotionHint(promotion.toObject(), req.query.locale === 'ar' ? 'ar' : 'en') }));
    return res.json({ success: true, promotions: active });
  } catch (error) { return sendControllerError(res, error); }
};

const listManaged = async (req, res) => {
  try {
    const filter = {};
    if (req.query.productId) filter.product = req.query.productId;
    if (req.query.status === 'enabled') filter.isActive = true;
    if (req.query.status === 'disabled') filter.isActive = false;
    const now = new Date();
    if (req.query.status === 'active') Object.assign(filter, { isActive: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] });
    if (req.query.status === 'scheduled') Object.assign(filter, { isActive: true, startsAt: { $gt: now } });
    if (req.query.status === 'expired') Object.assign(filter, { isActive: true, endsAt: { $lte: now } });
    const promotions = await Promotion.find(filter).populate('product', 'nameEn nameAr price imageUrls stock').sort({ priority: -1, createdAt: -1 });
    const ids = promotions.map((promotion) => promotion._id);
    const usage = await require('../models/Order').aggregate([
      { $unwind: '$appliedPromotions' }, { $match: { 'appliedPromotions.promotionId': { $in: ids } } },
      { $group: { _id: '$appliedPromotions.promotionId', count: { $sum: 1 } } },
    ]);
    const counts = new Map(usage.map((entry) => [String(entry._id), entry.count]));
    return res.json({ success: true, promotions: promotions.map((promotion) => ({ ...promotion.toObject(), hint: promotionHint(promotion.toObject(), req.query.locale === 'ar' ? 'ar' : 'en'), orderCount: counts.get(String(promotion._id)) || 0 })) });
  } catch (error) { return sendControllerError(res, error); }
};

const savePromotion = async (req, res) => {
  try {
    const existing = req.params.id ? await Promotion.findById(req.params.id) : null;
    if (req.params.id && !existing) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    const payload = { ...(existing?.toObject() || {}), ...req.body };
    if (!mongoose.Types.ObjectId.isValid(payload.product)) return res.status(400).json({ success: false, message: 'Choose a valid product.' });
    const product = await Product.findById(payload.product);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    const validationMessage = validatePromotion(payload, product);
    if (validationMessage) return res.status(400).json({ success: false, message: validationMessage });
    const duplicateCheck = await Promotion.find({ product: product._id, type: payload.type, _id: { $ne: existing?._id || null } });
    const rules = JSON.stringify(payload.tiers.map(({ minQty, getQty, percent, fixedPrice }) => ({ minQty: Number(minQty), getQty: Number(getQty) || undefined, percent: Number(percent) || undefined, fixedPrice: Number(fixedPrice) || undefined })).sort((a, b) => a.minQty - b.minQty));
    if (duplicateCheck.some((candidate) => JSON.stringify(candidate.tiers.map(({ minQty, getQty, percent, fixedPrice }) => ({ minQty, getQty: getQty || undefined, percent: percent || undefined, fixedPrice: fixedPrice || undefined })).sort((a, b) => a.minQty - b.minQty)) === rules)) {
      return res.status(409).json({ success: false, message: 'An identical rule already exists for this product.' });
    }
    const promotion = existing || new Promotion({ createdBy: req.user._id });
    ['product', 'name', 'description', 'type', 'tiers', 'startsAt', 'endsAt', 'isActive', 'stackable', 'priority'].forEach((key) => {
      if (payload[key] !== undefined) promotion[key] = payload[key];
    });
    await promotion.save();
    return res.status(existing ? 200 : 201).json({ success: true, promotion });
  } catch (error) { return sendControllerError(res, error); }
};

const setPromotionStatus = async (req, res) => {
  try {
    const promotion = await Promotion.findByIdAndUpdate(req.params.id, { isActive: Boolean(req.body.isActive) }, { new: true, runValidators: true });
    if (!promotion) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    return res.json({ success: true, promotion });
  } catch (error) { return sendControllerError(res, error); }
};

const deletePromotion = async (req, res) => {
  try {
    const promotion = await Promotion.findByIdAndDelete(req.params.id);
    if (!promotion) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    return res.json({ success: true, message: 'Promotion deleted.' });
  } catch (error) { return sendControllerError(res, error); }
};

module.exports = { publicList, listManaged, create: savePromotion, update: savePromotion, setPromotionStatus, deletePromotion };
