// Product.js
const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
  volumeMl: { type: Number, required: true, min: 0.1 },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, default: 0, min: 0 },
  sku: { type: String, trim: true },
}, { _id: false });

const noteList = [{ type: String, trim: true, lowercase: true }];

const productSchema = new mongoose.Schema(
  {
    brand: {
      type: String,
      required: [true, 'Brand is required'],
      trim: true,
    },
    nameEn: {
      type: String,
      required: [true, 'English name is required'],
      trim: true,
    },
    nameAr: {
      type: String,
      trim: true,
    },
    descEn: {
      type: String,
      required: [true, 'English description is required'],
      trim: true,
    },
    descAr: {
      type: String,
      required: [true, 'Arabic description is required'],
      trim: true,
    },
    gender: {
      type: String,
      required: [true, 'Gender is required'],
      enum: ['men', 'women', 'unisex'],
      trim: true,
      lowercase: true,
    },
    concentration: {
      type: String,
      enum: ['Parfum', 'EDP', 'EDT', 'EDC', 'Oil'],
      trim: true,
    },
    fragranceFamily: {
      type: [{ type: String, trim: true, lowercase: true }],
      default: [],
    },
    notes: {
      top: { type: noteList, default: [] },
      middle: { type: noteList, default: [] },
      base: { type: noteList, default: [] },
    },
    season: {
      type: [{ type: String, enum: ['spring', 'summer', 'autumn', 'winter'], trim: true, lowercase: true }],
      default: [],
    },
    occasion: {
      type: [{ type: String, trim: true }],
      default: [],
    },
    longevity: { type: Number, min: 1, max: 5 },
    sillage: { type: Number, min: 1, max: 5 },
    price: {
      type: Number,
      required: [true, 'Product price is required'],
      min: 0,
      // Derived from the least expensive variant for catalog sorting/filtering.
    },
    compareAtPrice: {
      type: Number,
      default: null,
    },
    imageUrls: {
      type: [String],
      required: [true, 'At least one product image URL is required'],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: 'Product must have at least one image URL',
      },
    },
    variants: {
      type: [variantSchema],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0
          && new Set(arr.map((variant) => Number(variant.volumeMl))).size === arr.length,
        message: 'Product must have at least one variant with unique volume values',
      },
    },
    // Denormalized total stock, kept in sync from variants for catalog/promotions.
    stock: {
      type: Number,
      default: 0,
      min: 0,
    },
    baseProfitPerPiece: {
      type: Number,
      default: 0,
      min: 0,
      // FIXED currency amount per piece, NOT a percentage
    },
    affiliateCommission: {
      type: Number,
      default: 0,
      min: 0,
      // FIXED currency amount per product, NOT a percentage
    },
    productDiscount: {
      type: Number,
      default: 0,
      min: 0,
      // FIXED currency amount per product, NOT a percentage
    },
    isLatestArrival: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

productSchema.index(
  { nameEn: 'text', nameAr: 'text', brand: 'text', 'notes.top': 'text', 'notes.middle': 'text', 'notes.base': 'text', fragranceFamily: 'text' },
  { weights: { nameEn: 10, nameAr: 10, brand: 10, 'notes.top': 2, 'notes.middle': 2, 'notes.base': 2, fragranceFamily: 2 } }
);

module.exports = mongoose.model('Product', productSchema);
