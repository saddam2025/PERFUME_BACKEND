// productRoutes.js
const express = require('express');
const productController = require('../controllers/productController');
const upload = require('../middlewares/upload');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/',    productController.getProducts);
router.get('/suggest', productController.suggestProducts);
router.get('/filters', productController.getProductFilters);
router.get('/:id', productController.getProduct);

router.post(
  '/',
  protect,
  restrictTo('Manager', 'Admin'),
  upload.array('images', 15),
  productController.createProduct
);

router.put(
  '/:id',
  protect,
  restrictTo('Manager', 'Admin'),
  upload.array('images', 15),
  productController.updateProduct
);

router.delete(
  '/:id',
  protect,
  restrictTo('Manager', 'Admin'),
  productController.deleteProduct
);

module.exports = router;
