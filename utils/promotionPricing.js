const roundMoney = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const promotionHint = (promotion, locale = 'en') => {
  const tier = (promotion.tiers || []).slice().sort((a, b) => b.minQty - a.minQty)[0] || {};
  if (promotion.type === 'BUY_X_GET_Y_FREE') return locale === 'ar'
    ? `اشتري ${tier.minQty} واحصل على ${tier.getQty} مجانًا`
    : `Buy ${tier.minQty} get ${tier.getQty} free`;
  if (promotion.type === 'QUANTITY_PERCENT_DISCOUNT') return locale === 'ar'
    ? `خصم ${tier.percent}% عند شراء ${tier.minQty} فأكثر`
    : `${tier.percent}% off when you buy ${tier.minQty}+`;
  return locale === 'ar'
    ? `اشترِ ${tier.minQty} بسعر ${tier.fixedPrice}`
    : `Buy ${tier.minQty} for ${tier.fixedPrice}`;
};

const isPromotionAvailable = (promotion, now = new Date()) => promotion.isActive !== false
  && new Date(promotion.startsAt) <= now
  && (!promotion.endsAt || new Date(promotion.endsAt) > now);

// A tier consumes only the purchased units in its minQty. Apply the highest
// qualifying minQty repeatedly, then evaluate the leftover quantity again.
// This makes 7 with tiers 3+1 and 6+4 => 4 free; 9 => 5 free (6+4, then 3+1).
function freeUnitsForQuantity(tiers, quantity) {
  const sorted = (tiers || []).slice().sort((a, b) => b.minQty - a.minQty || b.getQty - a.getQty);
  let remaining = quantity;
  let free = 0;
  while (remaining > 0) {
    const tier = sorted.find((candidate) => candidate.minQty <= remaining);
    if (!tier) break;
    const blocks = Math.floor(remaining / tier.minQty);
    free += blocks * tier.getQty;
    remaining -= blocks * tier.minQty;
  }
  return free;
}

function promotionBenefit(promotion, quantity, unitPrice) {
  const tiers = (promotion.tiers || []).slice().sort((a, b) => b.minQty - a.minQty);
  const tier = tiers.find((candidate) => candidate.minQty <= quantity);
  if (!tier) return { discount: 0, freeQty: 0 };
  if (promotion.type === 'BUY_X_GET_Y_FREE') {
    const freeQty = freeUnitsForQuantity(tiers, quantity);
    return { discount: roundMoney(freeQty * unitPrice), freeQty };
  }
  if (promotion.type === 'QUANTITY_PERCENT_DISCOUNT') {
    return { discount: roundMoney(quantity * unitPrice * tier.percent / 100), freeQty: 0 };
  }
  const blocks = Math.floor(quantity / tier.minQty);
  const bundledQty = blocks * tier.minQty;
  return { discount: roundMoney(blocks * tier.minQty * unitPrice - blocks * tier.fixedPrice), freeQty: 0, bundledQty };
}

function calculatePromotionPricing({ items, products, promotions = [], now = new Date() }) {
  const productMap = products instanceof Map ? products : new Map((products || []).map((product) => [String(product._id || product.id), product]));
  const grouped = new Map();
  for (const item of items || []) {
    if (Object.prototype.hasOwnProperty.call(item, 'size') || Object.prototype.hasOwnProperty.call(item, 'color')) {
      throw Object.assign(new Error('size and color are no longer supported; provide volumeMl.'), { statusCode: 400 });
    }
    const id = String(item.productId || item.product?._id || item.product?.id || '');
    const product = productMap.get(id);
    if (!product) throw Object.assign(new Error(`Product not found: ${id}`), { statusCode: 404 });
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw Object.assign(new Error('Each item quantity must be a positive integer.'), { statusCode: 400 });
    const volumeMl = Number(item.volumeMl);
    const variant = (product.variants || []).find((entry) => Number(entry.volumeMl) === volumeMl);
    if (!Number.isFinite(volumeMl) || !variant) throw Object.assign(new Error(`Please choose a valid volume for "${product.nameEn}".`), { statusCode: 400 });
    const key = `${id}::${volumeMl}`;
    if (!grouped.has(key)) grouped.set(key, { product, variant, volumeMl, items: [] });
    grouped.get(key).items.push({ ...item, productId: id, volumeMl, quantity });
  }

  let subtotal = 0;
  let totalDiscount = 0;
  let totalPayable = 0;
  let totalCommissionBase = 0;
  const pricedItems = [];
  const appliedPromotions = [];
  const productTotals = [];

  for (const group of grouped.values()) {
    const product = group.product;
    const productId = String(product._id || product.id);
    const unitPrice = Number(group.variant.price) || 0;
    const quantity = group.items.reduce((sum, item) => sum + item.quantity, 0);
    const eligible = promotions.filter((promotion) => String(promotion.product?._id || promotion.product) === productId && isPromotionAvailable(promotion, now));
    const candidates = eligible.map((promotion) => ({ promotion, ...promotionBenefit(promotion, quantity, unitPrice) }))
      .filter((candidate) => candidate.discount > 0 || candidate.freeQty > 0);
    const stackable = candidates.filter((candidate) => candidate.promotion.stackable);
    const nonStackable = candidates.filter((candidate) => !candidate.promotion.stackable)
      .sort((a, b) => b.discount - a.discount || (b.promotion.priority || 0) - (a.promotion.priority || 0) || String(a.promotion._id).localeCompare(String(b.promotion._id)));
    // Stackable promotions apply together; among non-stackable offers only the
    // one with the greatest monetary benefit applies. Priority/id break ties.
    const selected = [...stackable, ...(nonStackable.length ? [nonStackable[0]] : [])]
      .sort((a, b) => (b.promotion.priority || 0) - (a.promotion.priority || 0) || String(a.promotion._id).localeCompare(String(b.promotion._id)));
    const freeQty = selected.reduce((sum, candidate) => sum + candidate.freeQty, 0);
    const requestedFree = group.items.flatMap((item) => item.freeSelections || []).map((selection) => ({ ...selection, quantity: Number(selection.quantity) }));
    if (requestedFree.some((entry) => !Number.isInteger(entry.quantity) || entry.quantity < 1)) throw Object.assign(new Error('Free item quantities must be positive integers.'), { statusCode: 400 });
    if (!requestedFree.length && freeQty) {
      requestedFree.push({ volumeMl: group.volumeMl, quantity: freeQty });
    }
    for (const entry of requestedFree) {
      if (Object.prototype.hasOwnProperty.call(entry, 'size') || Object.prototype.hasOwnProperty.call(entry, 'color')) {
        throw Object.assign(new Error('Free selections must use volumeMl.'), { statusCode: 400 });
      }
      entry.volumeMl = Number(entry.volumeMl ?? group.volumeMl);
      if (!(product.variants || []).some((variant) => Number(variant.volumeMl) === entry.volumeMl)) {
        throw Object.assign(new Error(`Please choose a valid volume for the free item "${product.nameEn}".`), { statusCode: 400 });
      }
    }
    if (requestedFree.reduce((sum, entry) => sum + entry.quantity, 0) !== freeQty) {
      if (freeQty) throw Object.assign(new Error(`Select a volume for all ${freeQty} free item(s).`), { statusCode: 400 });
      if (requestedFree.length) throw Object.assign(new Error('This cart has no free units for the selected offer.'), { statusCode: 400 });
    }
    const paidSubtotal = roundMoney(quantity * unitPrice);
    const promoDiscount = Math.min(paidSubtotal, roundMoney(selected.reduce((sum, candidate) => sum + (candidate.promotion.type === 'BUY_X_GET_Y_FREE' ? 0 : candidate.discount), 0)));
    const freeItems = requestedFree.map((entry) => {
      const variant = product.variants.find((candidate) => Number(candidate.volumeMl) === entry.volumeMl);
      return { productId: product._id, name: product.nameEn, price: Number(variant.price), volumeMl: entry.volumeMl, quantity: entry.quantity };
    });
    const freeSavings = roundMoney(freeItems.reduce((sum, entry) => sum + entry.price * entry.quantity, 0));
    const lineDiscount = roundMoney(promoDiscount + freeSavings);
    const lineSubtotal = roundMoney(paidSubtotal + freeSavings);
    const lineTotal = roundMoney(paidSubtotal - promoDiscount);
    subtotal += lineSubtotal;
    totalDiscount += lineDiscount;
    totalPayable += lineTotal;
    totalCommissionBase += lineTotal;
    productTotals.push({ productId: product._id, quantity, paidSubtotal, paidTotal: lineTotal, freeQty });

    for (const item of group.items) {
      pricedItems.push({ productId: product._id, name: product.nameEn, quantity: item.quantity, price: unitPrice, volumeMl: group.volumeMl, freeItems: [] });
    }
    if (freeItems.length && group.items.length) group.items[group.items.length - 1].pricedFreeItems = freeItems;
    if (freeItems.length) pricedItems[pricedItems.length - 1].freeItems = freeItems;
    let remainingFreeItems = freeItems.map((entry) => ({ ...entry }));
    for (const candidate of selected) {
      let promotionFreeItems = [];
      if (candidate.freeQty > 0) {
        let needed = candidate.freeQty;
        while (needed > 0 && remainingFreeItems.length) {
          const entry = remainingFreeItems[0];
          const allocated = Math.min(entry.quantity, needed);
          promotionFreeItems.push({ ...entry, quantity: allocated });
          entry.quantity -= allocated;
          needed -= allocated;
          if (entry.quantity === 0) remainingFreeItems.shift();
        }
      }
      appliedPromotions.push({
        promotionId: candidate.promotion._id,
        productId: product._id,
        name: candidate.promotion.name,
        type: candidate.promotion.type,
        ruleDescription: promotionHint(candidate.promotion),
        tiers: candidate.promotion.tiers,
        stackable: Boolean(candidate.promotion.stackable),
        freeItems: promotionFreeItems,
        discountAmount: candidate.discount,
      });
    }
    group.promotionDiscount = promoDiscount;
    group.paidSubtotal = paidSubtotal;
    group.freeQty = freeQty;
  }

  return {
    items: pricedItems,
    appliedPromotions,
    subtotal: roundMoney(subtotal),
    totalDiscount: roundMoney(totalDiscount),
    totalOrderPrice: roundMoney(totalPayable),
    paidSubtotal: roundMoney(productTotals.reduce((sum, line) => sum + line.paidSubtotal, 0)),
    totalCommissionBase: roundMoney(totalCommissionBase),
    productTotals,
  };
}

module.exports = { calculatePromotionPricing, promotionHint, isPromotionAvailable, freeUnitsForQuantity, roundMoney };
