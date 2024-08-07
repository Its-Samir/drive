import { Router } from "express";
import { verifyJWT } from "../middlewares/verify-jwt";
import {
	uploadFile,
	createFolder,
	deleteItem,
	editItem,
	getItemInfo,
	getItems,
	getItemsByQuery,
	getItemsCount,
	getSharedItems,
	makeTrash,
	manageStarredItems,
	restoreItem,
	shareItem,
} from "../controllers/items.controller";
import multer from "multer";
import { storage } from "../middlewares/multer-upload.js";

const router = Router();

router.use(verifyJWT);

router.get("/items", getItemsByQuery);
router.get("/items/count", getItemsCount);
router.get("/items/files-folders/*", getItems);
router.get("/items/shared/*", getSharedItems);
router.get("/items/:itemId", getItemInfo);
router.post("/items/files/*", multer({ storage }).single("file"), uploadFile);
router.post("/items/folders/*", createFolder);
router.put("/items/:itemId", editItem);
router.put("/items/:itemId/starred", manageStarredItems);
router.put("/items/:itemId/share", shareItem);
router.put("/items/:itemId/trash", makeTrash);
router.put("/items/:itemId/restore", restoreItem);
router.delete("/items/:itemId", deleteItem);

export default router;
