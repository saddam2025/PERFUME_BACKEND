// backend/models/Order.js
const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    volumeMl: {
      type: Number,
      default: null,
      min: 0.1,
    },
    freeItems: [{
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      name: { type: String, required: true },
      price: { type: Number, min: 0, required: true },
      volumeMl: { type: Number, default: null, min: 0.1 },
      quantity: { type: Number, min: 1, required: true },
    }],
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: 'Order must contain at least one item',
      },
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    affiliateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    totalDiscount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    promotionDiscount: { type: Number, default: 0, min: 0 },
    affiliateDiscount: { type: Number, default: 0, min: 0 },
    promotionPricingVersion: { type: Number, default: 0 },
    appliedPromotions: [{
      promotionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      name: { type: String, required: true },
      type: { type: String, required: true },
      ruleDescription: { type: String, required: true },
      tiers: { type: [mongoose.Schema.Types.Mixed], default: [] },
      stackable: { type: Boolean, default: false },
      freeItems: { type: [mongoose.Schema.Types.Mixed], default: [] },
      discountAmount: { type: Number, min: 0, default: 0 },
    }],
    totalAffiliateCommission: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalOrderPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    shippingCost: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['Pending', 'Shipped', 'Delivered', 'Cancelled'],
      default: 'Pending',
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ['COD', 'Card'],
      default: 'COD',
    },
    paymentStatus: {
      type: String,
      enum: ['Pending', 'Paid', 'Failed'],
      default: 'Pending',
    },
    paymobOrderId: {
      type: Number,
      default: null,
    },
    paymobTransactionId: {
      type: String,
      default: null,
    },
    // Also previously missing entirely. Checkout.jsx collects name/address/
    // phone but the COD flow (createOrder) never read shippingDetails from
    // the request body at all, and the Paymob flow only used it to build
    // Paymob's billing_data — it was never actually saved onto the Order
    // document either.
    shippingDetails: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      address: { type: String, default: null },
      city: { type: String, default: null },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Order', orderSchema);
