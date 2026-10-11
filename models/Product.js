// Product.js
const mongoose = require('mongoose');

const CATEGORIES = ['t-shirt', 'jacket', 'hoodie', 'sweater', 'pants'];

/**
 * Product Schema
 * Represents a sellable item in the catalog, managed by Admin/Manager roles.
 *
 * Sizing convention (enforced at the application layer, not the schema):
 * - Tops (t-shirt, jacket, hoodie, sweater): "M", "L", "XL", "2XL"
 * - Pants: "32", "34", "36", "38", "40", "42"
 * `sizes` and `stockBySize` are intentionally generic (String[] / Map<String,
 * Number>) so either convention fits without a schema change.
 */
const productSchema = new mongoose.Schema(
  {
    nameEn: {
      type: String,
      required: [true, 'English name is required'],
      trim: true,
    },
    nameAr: {
      type: String,
      required: [true, 'Arabic name is required'],
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
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: CATEGORIES,
      trim: true,
      lowercase: true,
    },
    price: {
      type: Number,
      required: [true, 'Product price is required'],
      min: 0,
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
    colors: {
      // Accept legacy string names and the newer { name, nameEn, nameAr, hex } values.
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    sizes: {
      type: [String],
      default: [],
    },
    stockBySize: {
      type: Map,
      of: Number,
      default: {},
    },
    // Optional per-size-and-color inventory. Keys use `${size}::${color}`;
    // existing products continue to use stockBySize or aggregate stock.
    stockByVariant: {
      type: Map,
      of: Number,
      default: {},
    },
    // Denormalized sum of stockBySize, kept in sync by the controller on
    // create/update. Exists purely so the dashboard's product table can show
    // a total without summing the map client-side on every render.
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
    sizeGuideImageUrl: {
      type: String,
      default: null,
      trim: true,
    },
    isLatestArrival: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Product', productSchema);
module.exports.CATEGORIES = CATEGORIES;
