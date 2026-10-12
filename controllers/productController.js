// productController.js — FIXED
// Fix: Bug 1 — return 200 with empty array instead of 404 when no products match filters.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Collection = require('../models/Collection');
const Promotion = require('../models/Promotion');
const sendControllerError = require('../utils/controllerError');
const { isPromotionAvailable, promotionHint } = require('../utils/promotionPricing');

function productHasStock(product) {
  return (product.variants || []).some((variant) => Number(variant.stock) > 0);
}

async function addActivePromotionSummaries(products) {
  if (!products.length) return products;
  const ids = products.map((product) => product._id);
  const now = new Date();
  const promotions = await Promotion.find({ product: { $in: ids }, isActive: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }).sort({ priority: -1, startsAt: -1 });
  const grouped = new Map();
  for (const promotion of promotions) {
    const id = String(promotion.product);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({
      _id: promotion._id,
      name: promotion.name,
      description: promotion.description,
      type: promotion.type,
      tiers: promotion.tiers,
      stackable: promotion.stackable,
      priority: promotion.priority,
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      hint: promotionHint(promotion.toObject()),
    });
  }
  return products.map((product) => {
    const availablePromotions = productHasStock(product) ? grouped.get(String(product._id)) || [] : [];
    const value = product.toObject ? product.toObject() : product;
    return { ...value, promotions: availablePromotions, hasActivePromotion: availablePromotions.length > 0, promotionHint: availablePromotions[0]?.hint || null };
  });
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commaSeparated(value, { numeric = false, lowercase = false } = {}) {
  if (!value) return [];
  const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!numeric) return lowercase ? values.map((entry) => entry.toLowerCase()) : values;
  const numbers = values.map(Number);
  if (numbers.some((entry) => !Number.isFinite(entry) || entry <= 0)) badRequest('volume must contain positive numbers.');
  return numbers;
}

function productVisibilityFilter() {
  // Older products predate this field; treat missing values as active.
  return { isActive: { $ne: false } };
}

function buildProductFilters({ gender, family, notes, concentration, season, volume, minPrice, maxPrice, inStock }) {
  const query = productVisibilityFilter();
  const genders = commaSeparated(gender, { lowercase: true });
  const families = commaSeparated(family, { lowercase: true });
  const noteValues = commaSeparated(notes, { lowercase: true });
  const concentrations = commaSeparated(concentration);
  const seasons = commaSeparated(season, { lowercase: true });
  const volumes = commaSeparated(volume, { numeric: true });
  if (genders.length) query.gender = { $in: genders };
  if (families.length) query.fragranceFamily = { $in: families };
  if (noteValues.length) query.$or = [
    { 'notes.top': { $in: noteValues } },
    { 'notes.middle': { $in: noteValues } },
    { 'notes.base': { $in: noteValues } },
  ];
  if (concentrations.length) query.concentration = { $in: concentrations };
  if (seasons.length) query.season = { $in: seasons };

  const variantFilter = {};
  if (volumes.length) variantFilter.volumeMl = { $in: volumes };
  if (minPrice !== undefined || maxPrice !== undefined) {
    variantFilter.price = {};
    if (minPrice !== undefined) variantFilter.price.$gte = Number(minPrice);
    if (maxPrice !== undefined) variantFilter.price.$lte = Number(maxPrice);
  }
  if (String(inStock).toLowerCase() === 'true') variantFilter.stock = { $gt: 0 };
  if (Object.keys(variantFilter).length) query.variants = { $elemMatch: variantFilter };
  return query;
}

const LEGACY_PRODUCT_FIELDS = ['category', 'productType', 'sizes', 'colors', 'stockBySize', 'stockByVariant', 'sizeGuideImageUrl'];
const GENDERS = ['men', 'women', 'unisex'];
const CONCENTRATIONS = ['Parfum', 'EDP', 'EDT', 'EDC', 'Oil'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

function badRequest(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function rejectLegacyFields(body) {
  const found = LEGACY_PRODUCT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (found.length) badRequest(`Unsupported clothing product fields: ${found.join(', ')}.`);
}

function parseJsonFieldStrict(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return badRequest(`${field} must be valid JSON.`);
  }
}

function normalizeStringList(value, field, { lowercase = false, allowed = null } = {}) {
  const parsed = parseJsonFieldStrict(value, [], field);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    return badRequest(`${field} must be an array of strings.`);
  }
  const result = parsed.map((entry) => (lowercase ? entry.trim().toLowerCase() : entry.trim())).filter(Boolean);
  if (allowed && result.some((entry) => !allowed.includes(entry))) {
    return badRequest(`${field} contains an unsupported value.`);
  }
  return result;
}

function normalizeNotes(value) {
  const notes = parseJsonFieldStrict(value, {}, 'notes');
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return badRequest('notes must be an object.');
  return Object.fromEntries(['top', 'middle', 'base'].map((part) => [
    part,
    normalizeStringList(notes[part], `notes.${part}`, { lowercase: true }),
  ]));
}

function normalizeVariants(value) {
  const variants = parseJsonFieldStrict(value, [], 'variants');
  if (!Array.isArray(variants) || variants.length === 0) return badRequest('At least one variant is required.');
  const volumes = new Set();
  return variants.map((variant, index) => {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return badRequest(`variants[${index}] must be an object.`);
    if (variant.volumeMl === undefined || variant.volumeMl === null || variant.volumeMl === '' || variant.price === undefined || variant.price === null || variant.price === '') {
      return badRequest(`variants[${index}] requires volumeMl and price.`);
    }
    const volumeMl = Number(variant.volumeMl);
    const price = Number(variant.price);
    const stock = variant.stock === undefined || variant.stock === '' ? 0 : Number(variant.stock);
    if (!Number.isFinite(volumeMl) || volumeMl <= 0 || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
      return badRequest(`variants[${index}] requires a positive volume, a non-negative price, and non-negative integer stock.`);
    }
    if (volumes.has(volumeMl)) return badRequest('Variant volumes must be unique.');
    volumes.add(volumeMl);
    if (variant.sku !== undefined && typeof variant.sku !== 'string') return badRequest(`variants[${index}].sku must be a string.`);
    return { volumeMl, price, stock, ...(variant.sku !== undefined ? { sku: variant.sku.trim() } : {}) };
  });
}

function normalizeOptionalRating(value, field, fallback) {
  if (value === undefined) return fallback;
  if (value === '' || value === null) return undefined;
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return badRequest(`${field} must be between 1 and 5.`);
  return rating;
}

function parsePerfumeFields(body, existing = null) {
  const value = (field, fallback) => body[field] !== undefined ? body[field] : (existing ? existing[field] : fallback);
  const brand = String(value('brand', '') || '').trim();
  const nameEn = String(value('nameEn', '') || '').trim();
  const descEn = String(value('descEn', '') || '').trim();
  const descAr = String(value('descAr', '') || '').trim();
  const gender = String(value('gender', '') || '').trim().toLowerCase();
  if (!brand || !nameEn || !descEn || !descAr) badRequest('Brand, English name, and English and Arabic descriptions are required.');
  if (!GENDERS.includes(gender)) badRequest('gender must be men, women, or unisex.');

  const concentration = value('concentration', undefined);
  const concentrationValue = concentration == null ? '' : String(concentration).trim();
  if (concentrationValue && !CONCENTRATIONS.includes(concentrationValue)) {
    badRequest(`concentration must be one of: ${CONCENTRATIONS.join(', ')}.`);
  }

  const variants = normalizeVariants(parseJsonFieldStrict(value('variants', undefined), existing?.variants, 'variants'));
  const season = normalizeStringList(value('season', undefined), 'season', { lowercase: true, allowed: SEASONS });
  const fragranceFamily = normalizeStringList(value('fragranceFamily', undefined), 'fragranceFamily', { lowercase: true });
  const occasion = normalizeStringList(value('occasion', undefined), 'occasion');
  const notes = normalizeNotes(parseJsonFieldStrict(value('notes', undefined), existing?.notes, 'notes'));
  const fields = {
    brand,
    nameEn,
    nameAr: String(value('nameAr', '') || '').trim(),
    descEn,
    descAr,
    gender,
    ...(concentration !== undefined ? { concentration: concentrationValue || undefined } : {}),
    fragranceFamily,
    notes,
    season,
    occasion,
    longevity: normalizeOptionalRating(value('longevity', undefined), 'longevity', existing?.longevity),
    sillage: normalizeOptionalRating(value('sillage', undefined), 'sillage', existing?.sillage),
    variants,
    price: Math.min(...variants.map((variant) => variant.price)),
    stock: variants.reduce((sum, variant) => sum + variant.stock, 0),
  };

  if (body.compareAtPrice !== undefined) fields.compareAtPrice = body.compareAtPrice === '' ? null : Number(body.compareAtPrice);
  for (const field of ['baseProfitPerPiece', 'affiliateCommission', 'productDiscount']) {
    if (body[field] !== undefined) fields[field] = Number(body[field]) || 0;
  }
  if (body.isLatestArrival !== undefined) fields.isLatestArrival = body.isLatestArrival === 'false' ? false : body.isLatestArrival === false ? false : true;
  if (body.collections !== undefined) fields.collections = parseJsonField(body.collections, []);
  return fields;
}

exports.getProducts = async (req, res) => {
  try {
    const { category, productType, gender, family, notes, concentration, season, volume, search, minPrice, maxPrice, inStock, collectionId, page, limit, sort } = req.query;

    if (category !== undefined || productType !== undefined) {
      return res.status(400).json({ status: 'error', message: 'category and productType filters are no longer supported.' });
    }

    const parsePrice = (value, field) => {
      if (value === undefined) return undefined;
      const price = Number(value);
      if (!Number.isFinite(price) || price < 0) badRequest(`${field} must be a non-negative number.`);
      return price;
    };
    const lowerPrice = parsePrice(minPrice, 'minPrice');
    const upperPrice = parsePrice(maxPrice, 'maxPrice');
    if (lowerPrice !== undefined && upperPrice !== undefined && lowerPrice > upperPrice) {
      badRequest('minPrice cannot be greater than maxPrice.');
    }

    const baseQuery = buildProductFilters({ gender, family, notes, concentration, season, volume, minPrice: lowerPrice, maxPrice: upperPrice, inStock });
    let query = baseQuery;
    if (search && search.trim()) {
      const escapedSearch = escapeRegex(search.trim());
      const partialMatch = { $or: [
        { nameEn: new RegExp(escapedSearch, 'i') },
        { nameAr: new RegExp(escapedSearch, 'i') },
        { brand: new RegExp(escapedSearch, 'i') },
      ] };
      const [textIds, partialIds] = await Promise.all([
        Product.distinct('_id', { $and: [baseQuery, { $text: { $search: search.trim() } }] }),
        Product.distinct('_id', { $and: [baseQuery, partialMatch] }),
      ]);
      query = { $and: [baseQuery, { _id: { $in: [...new Set([...textIds, ...partialIds].map(String))] } }] };
    }

    if (collectionId) {
      query = { $and: [query, { collections: collectionId }] };
    }

    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 12, 1), 48);
    const skip = (pageNum - 1) * limitNum;

    const [allProducts, total] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }),
      Product.countDocuments(query),
    ]);
    const productsWithPromotions = await addActivePromotionSummaries(allProducts);
    const getMinPrice = (product) => Math.min(...(product.variants || []).map((variant) => Number(variant.price)).filter(Number.isFinite));
    if (sort === 'price_asc') productsWithPromotions.sort((a, b) => getMinPrice(a) - getMinPrice(b));
    else if (sort === 'price_desc') productsWithPromotions.sort((a, b) => getMinPrice(b) - getMinPrice(a));
    else if (sort === 'name_asc') productsWithPromotions.sort((a, b) => String(a.nameEn || '').localeCompare(String(b.nameEn || '')));
    const products = productsWithPromotions.slice(skip, skip + limitNum);

    // FIX Bug 1: was returning 404 for empty results. 404 means route not found,
    // not "no products match". Return 200 with an empty array so callers can
    // distinguish "no results" from "endpoint missing" and render empty states correctly.
    res.status(200).json({
      status: 'success',
      results: products.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum) || 1,
      data: { products },
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

exports.suggestProducts = async (req, res) => {
  try {
    const search = String(req.query.q || '').trim();
    if (search.length < 2) return res.json([]);
    const regex = new RegExp(escapeRegex(search), 'i');
    const products = await Product.find({ ...productVisibilityFilter(), $or: [{ nameEn: regex }, { nameAr: regex }, { brand: regex }] })
      .select('nameEn nameAr brand imageUrls variants')
      .sort({ nameEn: 1 })
      .limit(6);
    return res.json(products.map((product) => ({
      _id: product._id,
      name: product.nameEn,
      nameAr: product.nameAr,
      brand: product.brand,
      image: product.imageUrls?.[0] || null,
      minPrice: Math.min(...(product.variants || []).map((variant) => Number(variant.price)).filter(Number.isFinite)),
    })));
  } catch (error) {
    return sendControllerError(res, error);
  }
};

exports.getProductFilters = async (req, res) => {
  try {
    const visible = productVisibilityFilter();
    const [brands, fragranceFamily, topNotes, middleNotes, baseNotes, volumes, priceRange] = await Promise.all([
      Product.distinct('brand', visible),
      Product.distinct('fragranceFamily', visible),
      Product.distinct('notes.top', visible),
      Product.distinct('notes.middle', visible),
      Product.distinct('notes.base', visible),
      Product.distinct('variants.volumeMl', visible),
      Product.aggregate([
        { $match: visible },
        { $unwind: '$variants' },
        { $group: { _id: null, minPrice: { $min: '$variants.price' }, maxPrice: { $max: '$variants.price' } } },
      ]),
    ]);
    const notes = [...new Set([...topNotes, ...middleNotes, ...baseNotes].filter(Boolean))].sort();
    return res.json({
      brands: brands.filter(Boolean).sort(),
      fragranceFamily: fragranceFamily.filter(Boolean).sort(),
      notes,
      volumes: volumes.filter(Number.isFinite).sort((a, b) => a - b),
      minPrice: priceRange[0]?.minPrice ?? null,
      maxPrice: priceRange[0]?.maxPrice ?? null,
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

exports.getProduct = async (req, res) => {
  try {
    let product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        status: 'error',
        message: 'Product not found.',
      });
    }

    [product] = await addActivePromotionSummaries([product]);

    res.status(200).json({
      status: 'success',
      data: { product },
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
};

exports.createProduct = async (req, res) => {
  try {
    rejectLegacyFields(req.body);
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'At least one product image is required.',
      });
    }

    const fields = parsePerfumeFields(req.body);

    const imageUrls = req.files.map((file) => `/uploads/${file.filename}`);

    const newProduct = await Product.create({ ...fields, imageUrls });

    res.status(201).json({
      status: 'success',
      data: { product: newProduct },
    });
  } catch (error) {
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => fs.unlink(file.path, () => {}));
    }
    return sendControllerError(res, error);
  }
};

exports.updateProduct = async (req, res) => {
  try {
    rejectLegacyFields(req.body);
    const product = await Product.findById(req.params.id);

    if (!product) {
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => fs.unlink(file.path, () => {}));
      }
      return res.status(404).json({
        status: 'error',
        message: 'Product not found.',
      });
    }

    Object.assign(product, parsePerfumeFields(req.body, product));

    if (req.files && req.files.length > 0) {
      const oldImageUrls = product.imageUrls;
      product.imageUrls = req.files.map((file) => `/uploads/${file.filename}`);

      oldImageUrls.forEach((url) => {
        if (url.startsWith('/uploads/')) {
          const filePath = path.join(__dirname, '..', url);
          fs.unlink(filePath, () => {});
        }
      });
    }

    const updatedProduct = await product.save();

    res.status(200).json({
      status: 'success',
      data: { product: updatedProduct },
    });
  } catch (error) {
    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => fs.unlink(file.path, () => {}));
    }
    return sendControllerError(res, error);
  }
};

exports.deleteProduct = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const product = await Product.findById(req.params.id).session(session);

    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({
        status: 'error',
        message: 'Product not found.',
      });
    }

    await Collection.updateMany({ products: product._id }, { $pull: { products: product._id } }, { session });
    await Promotion.updateMany({ product: product._id }, { $set: { isActive: false } }, { session });
    await product.deleteOne({ session });
    await session.commitTransaction();

    if (product.imageUrls && product.imageUrls.length > 0) {
      product.imageUrls.forEach((url) => {
        if (url.startsWith('/uploads/')) {
          const filePath = path.join(__dirname, '..', url);
          fs.unlink(filePath, () => {});
        }
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Product deleted.',
    });
  } catch (error) {
    await session.abortTransaction();
    return sendControllerError(res, error);
  } finally {
    session.endSession();
  }
};
