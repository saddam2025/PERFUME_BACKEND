const router=require('express').Router(),c=require('../controllers/homepageContentController'),upload=require('../middlewares/upload'),{protect,restrictTo}=require('../middlewares/authMiddleware');
const admin=[protect,restrictTo('Manager','Admin')];
router.get('/',c.publicContent);router.get('/manage',...admin,c.manage);
router.post('/slides',...admin,upload.single('image'),c.saveSlide);router.put('/slides/:id',...admin,upload.single('image'),c.saveSlide);router.delete('/slides/:id',...admin,c.deleteSlide);
router.post('/types',...admin,upload.single('image'),c.saveType);router.put('/types/:id',...admin,upload.single('image'),c.saveType);router.delete('/types/:id',...admin,c.deleteType);
module.exports=router;
