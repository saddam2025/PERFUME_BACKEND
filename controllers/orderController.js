// backend/controllers/orderController.js
const mongoose = require('mongoose');
const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const AffiliateProfile = require('../models/AffiliateProfile');
const User = require('../models/User');
const Promotion = require('../models/Promotion');
const sendControllerError = require('../utils/controllerError');
const { calculatePromotionPricing, roundMoney } = require('../utils/promotionPricing');

const PAYMOB_BASE_URL = process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com/api';
const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY;
const PAYMOB_INTEGRATION_ID_CARD = process.env.PAYMOB_INTEGRATION_ID_CARD;
const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID;
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;
const getShippingInfo = (details = {}) => ({
  name: String(details.name || '').trim(),
  phone: String(details.phone || '').trim(),
  address: String(details.address || '').trim(),
  city: String(details.city || '').trim(),
});

const reserveProductStock = (product, requestedItem, quantity) => {
  const volumeMl = Number(requestedItem.volumeMl);
  const variant = (product.variants || []).find((entry) => Number(entry.volumeMl) === volumeMl);
  if (!Number.isFinite(volumeMl) || !variant) return `Please choose a valid volume for "${product.nameEn}".`;
  const available = Number(variant.stock) || 0;
  if (available < quantity) return `Insufficient stock for "${product.nameEn}" (${volumeMl} ml). Available: ${available}, requested: ${quantity}.`;
  variant.stock = available - quantity;
  product.stock = product.variants.reduce((sum, entry) => sum + (Number(entry.stock) || 0), 0);
  return null;
};

const restoreCancelledOrder = async (order, session) => {
  for (const item of order.items) {
    const product = await Product.findById(item.productId).session(session);
    if (!product) continue;
    const stockEntries = [{ volumeMl: item.volumeMl, quantity: item.quantity }, ...(item.freeItems || [])];
    for (const entry of stockEntries) {
      const variant = (product.variants || []).find((candidate) => Number(candidate.volumeMl) === Number(entry.volumeMl));
      if (!variant) throw Object.assign(new Error(`Cannot restore stock for missing ${entry.volumeMl} ml variant of "${product.nameEn}".`), { statusCode: 409 });
      variant.stock = (Number(variant.stock) || 0) + Number(entry.quantity);
    }
    product.stock = product.variants.reduce((sum, variant) => sum + (Number(variant.stock) || 0), 0);
    await product.save({ session });
  }
  if (order.affiliateId && order.totalAffiliateCommission > 0) {
    const profile = await AffiliateProfile.findOne({ userId: order.affiliateId }).session(session);
    if (profile) {
      profile.pendingBalance = Math.max(0, profile.pendingBalance - order.totalAffiliateCommission);
      await profile.save({ session });
    }
  }
};

async function priceAndReserveCart(items, session, { reserve = true } = {}) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Order must include at least one item.'), { statusCode: 400 });
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    if (!mongoose.Types.ObjectId.isValid(item.productId) || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) {
      throw Object.assign(new Error(`Item at index ${index} requires a valid productId and a positive integer quantity.`), { statusCode: 400 });
    }
  }
  const productIds = [...new Set(items.map((item) => String(item.productId)))];
  let productQuery = Product.find({ _id: { $in: productIds } });
  if (session) productQuery = productQuery.session(session);
  const products = await productQuery;
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const now = new Date();
  let promotionQuery = Promotion.find({ product: { $in: productIds }, isActive: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] });
  if (session) promotionQuery = promotionQuery.session(session);
  const promotions = await promotionQuery;
  const pricing = calculatePromotionPricing({ items, products: productMap, promotions, now });
  if (pricing.totalOrderPrice < 0) throw Object.assign(new Error('Order total cannot be negative.'), { statusCode: 400 });

  const inventoryMap = reserve ? productMap : new Map(products.map((product) => [String(product._id), {
    ...(product.toObject ? product.toObject() : product),
    variants: (product.variants || []).map((variant) => (variant.toObject ? variant.toObject() : { ...variant })),
  }]));
  for (const item of pricing.items) {
      const product = inventoryMap.get(String(item.productId));
      const stockError = reserveProductStock(product, item, item.quantity);
      if (stockError) throw Object.assign(new Error(stockError), { statusCode: 400 });
      for (const freeItem of item.freeItems || []) {
        const freeStockError = reserveProductStock(product, freeItem, freeItem.quantity);
        if (freeStockError) throw Object.assign(new Error(`Free item unavailable: ${freeStockError}`), { statusCode: 400 });
      }
  }
  if (reserve) {
    await Promise.all(products.map((product) => product.save(session ? { session } : undefined)));
  }
  pricing.productTotals = pricing.productTotals.map((line) => ({ ...line, product: productMap.get(String(line.productId)) }));
  return pricing;
}

const affiliateDiscountFor = (pricing, affiliateProfile) => {
  if (!affiliateProfile) return 0;
  return roundMoney(pricing.productTotals.reduce((sum, line) => sum + Math.min(Number(line.product.productDiscount || 0) * line.quantity, line.paidTotal), 0));
};

const previewOrderPricing = async (req, res) => {
  try {
    const pricing = await priceAndReserveCart(req.body.items, null, { reserve: false });
    const { affiliateCode } = req.body;
    let affiliateProfile = null;
    if (affiliateCode) {
      affiliateProfile = await AffiliateProfile.findOne({ customCode: String(affiliateCode).trim().toUpperCase() });
      if (!affiliateProfile) return res.status(400).json({ success: false, message: 'Invalid affiliate code.' });
      const affiliateUser = await User.findById(affiliateProfile.userId);
      if (!affiliateUser || affiliateUser.role !== 'Affiliate' || affiliateUser.status === 'suspended') return res.status(400).json({ success: false, message: 'This affiliate code is no longer active.' });
      if (req.user?._id && String(affiliateProfile.userId) === String(req.user._id)) return res.status(400).json({ success: false, message: 'You cannot use your own affiliate code.' });
    }
    const affiliateDiscount = affiliateDiscountFor(pricing, affiliateProfile);
    const shippingCost = pricing.paidSubtotal >= 6000 ? 0 : 100;
    return res.json({ success: true, pricing: {
      ...pricing,
      affiliateDiscount,
      totalDiscount: roundMoney(pricing.totalDiscount + affiliateDiscount),
      totalOrderPrice: roundMoney(Math.max(0, pricing.totalOrderPrice - affiliateDiscount) + shippingCost),
      shippingCost,
      promotionsApplied: pricing.appliedPromotions.length > 0,
    } });
  } catch (error) { return sendControllerError(res, error); }
};

const affiliateCommissionFor = (pricing, discount) => {
  if (!discount) return 0;
  const byProduct = pricing.productTotals.map((line) => {
    const lineAffiliateDiscount = Math.min(Number(line.product.productDiscount || 0) * line.quantity, line.paidTotal);
    const afterDiscount = Math.max(0, line.paidTotal - lineAffiliateDiscount);
    const ratio = line.paidSubtotal > 0 ? afterDiscount / line.paidSubtotal : 0;
    return Number(line.product.affiliateCommission || 0) * line.quantity * ratio;
  });
  return roundMoney(byProduct.reduce((sum, value) => sum + value, 0));
};

/**
 * @desc    Create a new order (Cash on Delivery / general checkout)
 * @route   POST /api/orders
 * @access  Private (Customer only)
 *
 * Body: { items: [{ productId, quantity, volumeMl }], affiliateCode?,
 *         shippingDetails?: { name, phone, address, city } }
 */
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const { items, affiliateCode, shippingDetails } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Order must include at least one item.',
      });
    }

    let affiliateProfile = null;
    let affiliateUser = null;

    if (affiliateCode && String(affiliateCode).trim().length > 0) {
      const normalizedCode = String(affiliateCode).trim().toUpperCase();

      affiliateProfile = await AffiliateProfile.findOne({
        customCode: normalizedCode,
      }).session(session);

      if (!affiliateProfile) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: 'Invalid affiliate code.',
        });
      }

      affiliateUser = await User.findById(affiliateProfile.userId).session(session);

      if (!affiliateUser || affiliateUser.role !== 'Affiliate') {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: 'This affiliate code is no longer active.',
        });
      }
      if (affiliateUser._id.equals(req.user._id)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'You cannot use your own affiliate code.' });
      }
    }

    const pricing = await priceAndReserveCart(items, session);
    const affiliateDiscount = affiliateDiscountFor(pricing, affiliateProfile);
    const shippingCost = pricing.paidSubtotal >= 6000 ? 0 : 100;
    const totalDiscount = roundMoney(pricing.totalDiscount + affiliateDiscount);
    const totalAffiliateCommission = affiliateCommissionFor(pricing, affiliateProfile);
    const totalOrderPrice = roundMoney(Math.max(0, pricing.totalOrderPrice - affiliateDiscount) + shippingCost);

    const order = await Order.create(
      [
        {
          customerId: req.user._id,
          items: pricing.items,
          subtotal: pricing.subtotal,
          affiliateId: affiliateUser ? affiliateUser._id : null,
          totalDiscount,
          promotionDiscount: pricing.totalDiscount,
          affiliateDiscount,
          shippingCost,
          promotionPricingVersion: 2,
          appliedPromotions: pricing.appliedPromotions,
          totalAffiliateCommission,
          totalOrderPrice,
          status: 'Pending',
          paymentMethod: 'COD',
          paymentStatus: 'Pending',
          // FIX: was never read from req.body at all before.
          shippingDetails: {
            name: shippingDetails?.name || null,
            phone: shippingDetails?.phone || null,
            address: shippingDetails?.address || null,
            city: shippingDetails?.city || null,
          },
        },
      ],
      { session }
    );

    if (affiliateProfile && totalAffiliateCommission > 0) {
      affiliateProfile.pendingBalance += totalAffiliateCommission;
      await affiliateProfile.save({ session });
    }

    const shippingInfo = getShippingInfo(shippingDetails);
    if (Object.values(shippingInfo).some(Boolean)) {
      req.user.shippingInfo = shippingInfo;
      await req.user.save({ session });
    }

    await session.commitTransaction();

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully.',
      order: order[0],
    });
  } catch (error) {
    await session.abortTransaction();
    return sendControllerError(res, error);
  } finally {
    session.endSession();
  }
};

const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.user._id }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, results: orders.length, orders });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

const cancelMyOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid order id.' });
    }
    const order = await Order.findById(req.params.id).session(session);
    if (!order || !order.customerId.equals(req.user._id)) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (order.status !== 'Pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Only pending orders can be cancelled.' });
    }
    await restoreCancelledOrder(order, session);
    order.status = 'Cancelled';
    await order.save({ session });
    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'Order cancelled.', order });
  } catch (error) {
    await session.abortTransaction();
    return sendControllerError(res, error);
  } finally {
    session.endSession();
  }
};

const getOrders = async (req, res) => {
  try {
    const { status, withPromotions } = req.query;
    const allowedStatuses = ['Pending', 'Shipped', 'Delivered', 'Cancelled'];

    const filter = {};
    if (status) {
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${allowedStatuses.join(', ')}.`,
        });
      }
      filter.status = status;
    }
    if (withPromotions === 'true') filter['appliedPromotions.0'] = { $exists: true };

    const orders = await Order.find(filter)
      .populate('customerId', 'name email')
      .populate('affiliateId', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, results: orders.length, orders });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const { status } = req.body;
    const allowedStatuses = ['Pending', 'Shipped', 'Delivered', 'Cancelled'];

    if (!status || !allowedStatuses.includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${allowedStatuses.join(', ')}.`,
      });
    }

    const order = await Order.findById(req.params.id).session(session);

    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    const nextStatuses = {
      Pending: ['Shipped', 'Cancelled'],
      Shipped: ['Delivered', 'Cancelled'],
      Delivered: [],
      Cancelled: [],
    };
    if (!nextStatuses[order.status]?.includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Order cannot move from '${order.status}' to '${status}'.` });
    }
    const previousStatus = order.status;

    if (status === 'Cancelled') await restoreCancelledOrder(order, session);

    order.status = status;
    await order.save({ session });

    let walletTransfer = null;

    if (status === 'Delivered' && order.affiliateId && order.totalAffiliateCommission > 0) {
      const affiliateProfile = await AffiliateProfile.findOne({ userId: order.affiliateId }).session(session);

      if (affiliateProfile) {
        const commission = order.totalAffiliateCommission;
        affiliateProfile.pendingBalance = Math.max(0, affiliateProfile.pendingBalance - commission);
        affiliateProfile.withdrawableBalance += commission;
        await affiliateProfile.save({ session });

        walletTransfer = {
          affiliateProfileId: affiliateProfile._id,
          customCode: affiliateProfile.customCode,
          amountMoved: commission,
          newPendingBalance: affiliateProfile.pendingBalance,
          newWithdrawableBalance: affiliateProfile.withdrawableBalance,
        };
      }
    }

    await session.commitTransaction();

    return res.status(200).json({
      success: true,
      message: `Order status updated from '${previousStatus}' to '${status}'.`,
      order,
      walletTransfer,
    });
  } catch (error) {
    await session.abortTransaction();
    return sendControllerError(res, error);
  } finally {
    session.endSession();
  }
};

const extractPaymobErrorDetail = (data) => {
  if (!data) return null;
  if (typeof data === 'string') return data;
  return data.detail || data.message || data.error || JSON.stringify(data);
};

const getPaymobAuthToken = async () => {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. This server requires Node.js 18 or newer.');
  }

  const response = await fetch(`${PAYMOB_BASE_URL}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: PAYMOB_API_KEY }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.token) {
    console.error('[Paymob] auth/tokens failed:', response.status, data);
    throw new Error(`Paymob auth failed (status ${response.status}): ${extractPaymobErrorDetail(data) || 'no detail returned'}`);
  }

  return data.token;
};

const registerPaymobOrder = async (authToken, { amountCents, merchantOrderId, items }) => {
  const response = await fetch(`${PAYMOB_BASE_URL}/ecommerce/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: authToken,
      delivery_needed: false,
      amount_cents: amountCents,
      currency: 'EGP',
      merchant_order_id: merchantOrderId,
      items,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.id) {
    console.error('[Paymob] ecommerce/orders failed:', response.status, data);
    throw new Error(`Paymob order registration failed (status ${response.status}): ${extractPaymobErrorDetail(data) || 'no detail returned'}`);
  }

  return data.id;
};

const getPaymobPaymentKey = async (authToken, { amountCents, paymobOrderId, billingData }) => {
  const payload = {
    auth_token: authToken,
    amount_cents: amountCents,
    expiration: 3600,
    order_id: paymobOrderId,
    billing_data: billingData,
    currency: 'EGP',
    integration_id: Number(PAYMOB_INTEGRATION_ID_CARD),
  };

  const response = await fetch(`${PAYMOB_BASE_URL}/acceptance/payment_keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.token) {
    console.error('[Paymob] payment_keys failed:', response.status, data);
    throw new Error(`Paymob payment key generation failed (status ${response.status}): ${extractPaymobErrorDetail(data) || 'no detail returned'}`);
  }

  return data.token;
};

/**
 * @desc    Create an order and start the Paymob 3-step payment flow
 * @route   POST /api/orders/pay/paymob
 * @access  Private (Customer/Affiliate/Admin/Manager)
 *
 * Body: { items: [{ productId, quantity, volumeMl }], affiliateCode?,
 *         shippingDetails?: { name, phone, address, city } }
 */
const initiatePaymobPayment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const { items, affiliateCode, shippingDetails } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Order must include at least one item.' });
    }

    if (!PAYMOB_API_KEY || !PAYMOB_INTEGRATION_ID_CARD || !PAYMOB_IFRAME_ID || !PAYMOB_HMAC_SECRET) {
      await session.abortTransaction();
      return res.status(500).json({
        success: false,
        message: 'Paymob is not configured on the server. Missing environment variables.',
      });
    }

    let affiliateProfile = null;
    let affiliateUser = null;

    if (affiliateCode && String(affiliateCode).trim().length > 0) {
      const normalizedCode = String(affiliateCode).trim().toUpperCase();
      affiliateProfile = await AffiliateProfile.findOne({ customCode: normalizedCode }).session(session);
      if (!affiliateProfile) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Invalid affiliate code.' });
      }
      affiliateUser = await User.findById(affiliateProfile.userId).session(session);
      if (!affiliateUser || affiliateUser.role !== 'Affiliate') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'This affiliate code is no longer active.' });
      }
      if (affiliateUser._id.equals(req.user._id)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'You cannot use your own affiliate code.' });
      }
    }

    const pricing = await priceAndReserveCart(items, session);
    const affiliateDiscount = affiliateDiscountFor(pricing, affiliateProfile);
    const shippingCost = pricing.paidSubtotal >= 6000 ? 0 : 100;
    const totalDiscount = roundMoney(pricing.totalDiscount + affiliateDiscount);
    const totalAffiliateCommission = affiliateCommissionFor(pricing, affiliateProfile);
    const totalOrderPrice = roundMoney(Math.max(0, pricing.totalOrderPrice - affiliateDiscount) + shippingCost);

    if (totalOrderPrice <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Order total must be greater than zero.' });
    }

    const amountCents = Math.round(totalOrderPrice * 100);

    // Paymob receives the authoritative server-calculated payable total as a
    // single line so discounts and free units cannot introduce cent drift.
    const paymobItems = [{ name: 'Toronto order', amount_cents: amountCents, description: 'Order total after promotions', quantity: 1 }];

    const order = await Order.create(
      [
        {
          customerId: req.user._id,
          items: pricing.items,
          subtotal: pricing.subtotal,
          affiliateId: affiliateUser ? affiliateUser._id : null,
          totalDiscount,
          promotionDiscount: pricing.totalDiscount,
          affiliateDiscount,
          shippingCost,
          promotionPricingVersion: 2,
          appliedPromotions: pricing.appliedPromotions,
          totalAffiliateCommission,
          totalOrderPrice,
          status: 'Pending',
          paymentMethod: 'Card',
          paymentStatus: 'Pending',
          // FIX: previously used ONLY for Paymob's billing_data, never
          // actually persisted onto the Order document.
          shippingDetails: {
            name: shippingDetails?.name || null,
            phone: shippingDetails?.phone || null,
            address: shippingDetails?.address || null,
            city: shippingDetails?.city || null,
          },
        },
      ],
      { session }
    );

    if (affiliateProfile && totalAffiliateCommission > 0) {
      affiliateProfile.pendingBalance += totalAffiliateCommission;
      await affiliateProfile.save({ session });
    }

    const shippingInfo = getShippingInfo(shippingDetails);
    if (Object.values(shippingInfo).some(Boolean)) {
      req.user.shippingInfo = shippingInfo;
      await req.user.save({ session });
    }

    await session.commitTransaction();

    const createdOrder = order[0];

    try {
      const authToken = await getPaymobAuthToken();

      const paymobOrderId = await registerPaymobOrder(authToken, {
        amountCents,
        merchantOrderId: createdOrder._id.toString(),
        items: paymobItems,
      });

      createdOrder.paymobOrderId = paymobOrderId;
      await createdOrder.save();

      const nameParts = (shippingDetails?.name || '').trim().split(' ');

      const billingData = {
        apartment: 'NA',
        email: req.user.email || 'na@example.com',
        floor: 'NA',
        first_name: nameParts[0] || 'NA',
        street: shippingDetails?.address || 'NA',
        building: 'NA',
        phone_number: shippingDetails?.phone || 'NA',
        shipping_method: 'NA',
        postal_code: 'NA',
        city: shippingDetails?.city || 'Cairo',
        country: 'EG',
        last_name: nameParts.slice(1).join(' ') || 'NA',
        state: shippingDetails?.city || 'Cairo',
      };

      const paymentToken = await getPaymobPaymentKey(authToken, { amountCents, paymobOrderId, billingData });

      const iframeUrl = `${PAYMOB_BASE_URL.replace(/\/api$/, '')}/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${paymentToken}`;

      return res.status(201).json({
        success: true,
        message: 'Payment initiated. Redirect the customer to the iframe URL.',
        orderId: createdOrder._id,
        totalOrderPrice: createdOrder.totalOrderPrice,
        appliedPromotions: createdOrder.appliedPromotions,
        iframeUrl,
      });
    } catch (paymobError) {
      console.error(`[Paymob] initiation failed for order ${createdOrder._id}:`, paymobError.message);
      return res.status(502).json({
        success: false,
        message: 'Order was created but Paymob payment initiation failed. Please retry payment.',
        orderId: createdOrder._id,
        error: process.env.NODE_ENV === 'production' ? undefined : paymobError.message,
      });
    }
  } catch (error) {
    await session.abortTransaction();
    console.error('[initiatePaymobPayment] failed before/around order creation:', error);
    return sendControllerError(res, error);
  } finally {
    session.endSession();
  }
};

const PAYMOB_TRANSACTION_HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
  'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
  'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
];

const getNestedValue = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : ''), obj);

const verifyPaymobHmac = (transactionObj, receivedHmac) => {
  const concatenated = PAYMOB_TRANSACTION_HMAC_FIELDS.map((field) => {
    const value = getNestedValue(transactionObj, field);
    return value === null || value === undefined ? '' : String(value);
  }).join('');
  const computedHmac = crypto.createHmac('sha512', PAYMOB_HMAC_SECRET).update(concatenated).digest('hex');
  return computedHmac === receivedHmac;
};

const paymobWebhook = async (req, res) => {
  try {
    const receivedHmac = req.query.hmac;
    const obj = req.body?.obj;

    if (!receivedHmac || !obj) {
      return res.status(400).json({ success: false, message: 'Missing hmac or transaction payload.' });
    }

    if (!verifyPaymobHmac(obj, receivedHmac)) {
      return res.status(401).json({ success: false, message: 'Invalid HMAC signature.' });
    }

    const merchantOrderId = obj.order?.merchant_order_id;

    if (!merchantOrderId || !mongoose.Types.ObjectId.isValid(merchantOrderId)) {
      return res.status(400).json({ success: false, message: 'Missing or invalid merchant_order_id.' });
    }

    const order = await Order.findById(merchantOrderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found for this transaction.' });
    }

    if (order.promotionPricingVersion === 2) {
      // Recompute against the immutable order snapshot, never today's edited
      // or deleted Promotion documents, then verify the signed payment total.
      const snapshotProducts = new Map();
      for (const item of order.items) {
        const id = String(item.productId);
        if (!snapshotProducts.has(id)) snapshotProducts.set(id, { _id: item.productId, nameEn: item.name, variants: [] });
        const product = snapshotProducts.get(id);
        for (const entry of [{ volumeMl: item.volumeMl, price: item.price }, ...(item.freeItems || [])]) {
          if (!product.variants.some((variant) => Number(variant.volumeMl) === Number(entry.volumeMl))) {
            product.variants.push({ volumeMl: entry.volumeMl, price: entry.price });
          }
        }
      }
      const snapshotPromotions = (order.appliedPromotions || []).map((entry) => ({
        ...(entry.toObject?.() || entry),
        _id: entry.promotionId,
        product: entry.productId,
        isActive: true,
        startsAt: new Date(0),
        endsAt: null,
      }));
      const snapshotItems = order.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        volumeMl: item.volumeMl,
        freeSelections: item.freeItems || [],
      }));
      const recalculated = calculatePromotionPricing({ items: snapshotItems, products: snapshotProducts, promotions: snapshotPromotions });
      if (Math.abs(recalculated.subtotal - order.subtotal) > 0.01
        || Math.abs(recalculated.totalDiscount - order.promotionDiscount) > 0.01
        || Math.abs(recalculated.totalOrderPrice - order.affiliateDiscount + order.shippingCost - order.totalOrderPrice) > 0.01) {
        console.error(`[Paymob] promotion snapshot total mismatch for order ${order._id}`);
        return res.status(409).json({ success: false, message: 'Order pricing snapshot could not be verified.' });
      }
    }

    if (order.paymentStatus === 'Paid') {
      return res.status(200).json({ success: true, message: 'Order already marked as Paid.' });
    }

    const isSuccessful = obj.success === true && obj.pending === false && !obj.error_occured;
    if (isSuccessful && Number(obj.amount_cents) !== Math.round(Number(order.totalOrderPrice) * 100)) {
      return res.status(400).json({ success: false, message: 'Payment amount does not match the order total.' });
    }

    order.paymentStatus = isSuccessful ? 'Paid' : 'Failed';
    order.paymobTransactionId = String(obj.id);
    await order.save();

    return res.status(200).json({ success: true });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

module.exports = {
  previewOrderPricing,
  createOrder,
  getMyOrders,
  cancelMyOrder,
  getOrders,
  updateOrderStatus,
  initiatePaymobPayment,
  paymobWebhook,
};
