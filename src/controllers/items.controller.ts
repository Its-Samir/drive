import { Request, Response, NextFunction } from "express";
import { ApiError, ApiResponse } from "../utils/responses.ts";
import { db } from "../utils/db.ts";
import { Item, MediaType } from "@prisma/client";
import crypto from "crypto";
import { deleteObject, ref } from "firebase/storage";
import { storage } from "../utils/firebase-config.ts";

export async function createFile(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const params = req.params[0].split("/");

		const folderId = params[params.length - 1];

		const { name, media, isPrivate, mediaType, size }: Item = req.body;

		if (!name || !media || !mediaType || !size) {
			throw new ApiError(400, "Required fields are missing");
		}

		if (folderId) {
			const existingFolder = await db.item.findFirst({
				where: {
					id: folderId,
					ownerId: req.userId,
					isFolder: true,
					isTrash: false,
				},
				select: {
					id: true,
					size: true,
					isPrivate: true,
					parent: {
						select: { id: true, childrens: true, parent: true },
					},
				},
			});

			if (!existingFolder) {
				throw new ApiError(404, "Folder not found");
			}

			const updatedSize = existingFolder.size + size;
			const previewUrl = crypto.randomBytes(12).toString("hex");

			await db.$transaction([
				db.item.create({
					data: {
						name,
						media,
						mediaType:
							mediaType === "PDF"
								? MediaType.PDF
								: mediaType === "IMAGE"
								? MediaType.IMAGE
								: mediaType === "VIDEO"
								? MediaType.VIDEO
								: mediaType === "OFFICE"
								? MediaType.OFFICE
								: MediaType.UNKNOWN,
						previewUrl,
						size,
						owner: { connect: { id: req.userId } },
						parent: { connect: { id: existingFolder.id } },
						isPrivate: isPrivate ? isPrivate : existingFolder.isPrivate,
					},
				}),

				db.item.update({
					where: { id: existingFolder.id },
					data: {
						size: updatedSize,
					},
				}),
			]);

			let currentParent: typeof existingFolder.parent =
				existingFolder.parent;

			while (currentParent) {
				const updatedSize =
					currentParent.childrens
						.map((i) => i.size)
						.reduce((a, c) => a + c) + size; // adding this size because in prisma transaction the updated size of the existing folder wouldn't affect immediately

				await db.item.update({
					where: {
						id: currentParent.id,
					},
					data: {
						size: updatedSize,
					},
				});

				currentParent =
					currentParent.parent as typeof existingFolder.parent;
			}

			return ApiResponse(res, 201, { message: "File created" });
		}

		const previewUrl = crypto.randomBytes(12).toString("hex");

		const file = await db.item.create({
			data: {
				name,
				media,
				mediaType:
					mediaType === "PDF"
						? MediaType.PDF
						: mediaType === "IMAGE"
						? MediaType.IMAGE
						: mediaType === "VIDEO"
						? MediaType.VIDEO
						: mediaType === "OFFICE"
						? MediaType.OFFICE
						: MediaType.UNKNOWN,
				previewUrl,
				size,
				owner: { connect: { id: req.userId } },
				isPrivate: isPrivate ? isPrivate : false,
			},
		});

		await db.user.update({
			where: { id: req.userId },
			data: {
				items: { connect: { id: file.id } },
			},
		});

		ApiResponse(res, 201, { message: "File created" });
	} catch (error) {
		next(error);
	}
}

export async function getItemInfo(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findFirst({
			where: {
				id: itemId,
				ownerId: req.userId,
				isTrash: false,
			},
			include: {
				sharedWith: {
					include: {
						user: {
							select: {
								email: true,
								name: true,
								image: true,
							},
						},
					},
				},
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		return ApiResponse(res, 200, { item });
	} catch (error) {
		next(error);
	}
}

export async function getItems(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const params = req.params[0].split("/");

		const folderId = params[params.length - 1];

		if (folderId) {
			const existingFolder = await db.item.findFirst({
				where: {
					id: folderId,
					ownerId: req.userId,
					isFolder: true,
					isTrash: false,
				},
			});

			if (!existingFolder) {
				throw new ApiError(404, "Folder not found");
			}

			const items = await db.item.findMany({
				where: {
					ownerId: req.userId,
					parentId: existingFolder.id,
					isTrash: false,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
					_count: {
						select: { childrens: true },
					},
				},
				orderBy: {
					isFolder: "desc",
				},
			});

			return ApiResponse(res, 200, { items });
		}

		const items = await db.item.findMany({
			where: { ownerId: req.userId, parent: null, isTrash: false },
			include: {
				owner: {
					select: {
						email: true,
						name: true,
						image: true,
					},
				},
				_count: {
					select: { childrens: true },
				},
			},
			orderBy: {
				isFolder: "desc",
			},
		});

		ApiResponse(res, 200, { items });
	} catch (error) {
		next(error);
	}
}

export async function editItem(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "itemId is missing");
		}

		const { name, isPrivate }: Item = req.body;

		if (!name) {
			throw new ApiError(400, "Required fields are missing");
		}

		const existingItem = await db.item.findFirst({
			where: {
				id: itemId,
				ownerId: req.userId,
			},
			select: {
				id: true,
				name: true,
				isPrivate: true,
			},
		});

		if (!existingItem) {
			throw new ApiError(404, "Item not found");
		}

		if (existingItem.name === name && existingItem.isPrivate === isPrivate) {
			/* prevent unnecessary updates but response is ok as the values are same */
			return ApiResponse(res, 200, { message: "Item updated" });
		}

		await db.item.update({
			where: { id: existingItem.id },
			data: {
				name,
				isPrivate,
			},
		});

		ApiResponse(res, 200, { message: "Item updated" });
	} catch (error) {
		next(error);
	}
}

export async function createFolder(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const params = req.params[0].split("/");

		const folderId = params[params.length - 1];

		const { name, isPrivate, size }: Item = req.body;

		if (!name) {
			throw new ApiError(400, "Required fields are missing");
		}

		const existingItem = await db.item.findFirst({
			where: { name, ownerId: req.userId },
		});

		if (existingItem) throw new ApiError(409, "Folder name already exists");

		if (folderId) {
			const existingFolder = await db.item.findFirst({
				where: {
					id: folderId,
					ownerId: req.userId,
					isFolder: true,
					isTrash: false,
				},
				select: {
					id: true,
					size: true,
					isPrivate: true,
				},
			});

			if (!existingFolder) {
				throw new ApiError(404, "Folder not found");
			}

			const updatedSize = existingFolder.size + size;
			const previewUrl = crypto.randomBytes(12).toString("hex");

			await db.$transaction([
				db.item.create({
					data: {
						name,
						previewUrl,
						isFolder: true,
						owner: { connect: { id: req.userId } },
						parent: { connect: { id: existingFolder.id } },
						isPrivate: isPrivate ? isPrivate : existingFolder.isPrivate,
						size: size ? size : 0,
					},
				}),

				db.item.update({
					where: { id: existingFolder.id },
					data: {
						size: updatedSize,
					},
				}),
			]);

			return ApiResponse(res, 201, { message: "Folder created" });
		}

		const previewUrl = crypto.randomBytes(12).toString("hex");

		const folder = await db.item.create({
			data: {
				name,
				previewUrl,
				isFolder: true,
				owner: { connect: { id: req.userId } },
				isPrivate: isPrivate ? isPrivate : false,
				size: size ? size : 0,
			},
		});

		await db.user.update({
			where: { id: req.userId },
			data: {
				items: { connect: { id: folder.id } },
			},
		});

		ApiResponse(res, 201, { message: "Folder created" });
	} catch (error) {
		next(error);
	}
}

export async function getItemsCount(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const [folder, file, privates, sharedByUser, sharedWithUser] =
			await db.$transaction([
				db.item.count({ where: { ownerId: req.userId, isFolder: true } }),
				db.item.count({ where: { ownerId: req.userId, isFolder: false } }),
				db.item.count({ where: { ownerId: req.userId, isPrivate: true } }),
				db.sharedItem.count({ where: { ownerId: req.userId } }),
				db.sharedItem.count({ where: { userId: req.userId } }),
			]);

		const data: { name: string; count: number }[] = [];

		Object.keys({
			folder,
			file,
			privates,
			sharedByUser,
			sharedWithUser,
		}).forEach((val) => {
			if (val === "folder") {
				data.push({ name: "Folder", count: folder });
			}
			if (val === "file") {
				data.push({ name: "File", count: file });
			}
			if (val === "privates") {
				data.push({ name: "Private", count: privates });
			}
			if (val === "sharedByUser") {
				data.push({ name: "Shared by You", count: sharedByUser });
			}
			if (val === "sharedWithUser") {
				data.push({ name: "Shared with You", count: sharedWithUser });
			}
		});

		ApiResponse(res, 200, data);
	} catch (error) {
		next(error);
	}
}

export async function getItemsByQuery(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		let items: any = [];

		const { type, mediaType, starred, shared, isPrivate, trashed } =
			req.query;

		if (type === "true" && mediaType) {
			items = await db.item.findMany({
				where: {
					ownerId: req.userId,
					mediaType:
						mediaType === "PDF"
							? MediaType.PDF
							: mediaType === "IMAGE"
							? MediaType.IMAGE
							: mediaType === "VIDEO"
							? MediaType.VIDEO
							: null,
					isFolder: false,
					isTrash: false,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});
		}

		if (starred === "true") {
			items = await db.item.findMany({
				where: {
					ownerId: req.userId,
					isStarred: true,
					isTrash: false,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});
		}

		if (shared === "true") {
			items = await db.item.findMany({
				where: {
					sharedWith: { some: { userId: req.userId } },
					isPrivate: true,
					isTrash: false,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});
		}

		if (isPrivate === "true") {
			items = await db.item.findMany({
				where: {
					ownerId: req.userId,
					isPrivate: true,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});
		}

		if (trashed === "true") {
			items = await db.item.findMany({
				where: {
					ownerId: req.userId,
					isTrash: true,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});
		}

		ApiResponse(res, 200, { items });
	} catch (error) {
		next(error);
	}
}

export async function getSharedItems(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const params = req.params[0].split("/");

		const folderId = params[params.length - 1];

		if (folderId) {
			const existingFolder = await db.item.findFirst({
				where: {
					id: folderId,
					isFolder: true,
					isTrash: false,
				},
				select: {
					id: true,
				},
			});

			if (!existingFolder) {
				throw new ApiError(404, "Folder not found");
			}

			const items = await db.item.findMany({
				where: {
					parentId: existingFolder.id,
					isPrivate: true,
					isTrash: false,
				},
				include: {
					owner: {
						select: {
							email: true,
							name: true,
							image: true,
						},
					},
				},
			});

			return ApiResponse(res, 200, { items });
		}

		const items = await db.item.findMany({
			where: {
				sharedWith: { some: { userId: req.userId } },
				isPrivate: true,
				isTrash: false,
			},
			include: {
				owner: {
					select: {
						email: true,
						name: true,
						image: true,
					},
				},
			},
		});

		ApiResponse(res, 200, { items });
	} catch (error) {
		next(error);
	}
}

export async function manageStarredItems(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const { itemId } = req.params;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findUnique({
			where: {
				id: itemId,
				ownerId: req.userId,
			},
			select: {
				id: true,
				isStarred: true,
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		if (!item.isStarred) {
			await db.item.update({
				where: {
					id: item.id,
				},
				data: {
					isStarred: true,
				},
			});

			return ApiResponse(res, 200, { message: "File Starred" });
		}

		await db.item.update({
			where: {
				id: item.id,
			},
			data: {
				isStarred: false,
			},
		});

		ApiResponse(res, 200, { message: "File Unstarred" });
	} catch (error) {
		next(error);
	}
}

export async function shareItem(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const { userId }: { userId: string } = req.body;

		if (!userId) {
			throw new ApiError(400, "Required field is missing");
		}

		if (userId === req.userId) {
			throw new ApiError(400, "You cannot share item to yourself");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findUnique({
			where: {
				id: itemId,
				isTrash: false,
				ownerId: req.userId,
				isPrivate: true,
			},
			select: {
				id: true,
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		const sharedItem = await db.sharedItem.findFirst({
			where: {
				ownerId: req.userId,
				userId: userId,
				itemId: item.id,
			},
			select: { id: true },
		});

		if (!sharedItem) {
			await db.sharedItem.create({
				data: {
					ownerId: req.userId,
					user: { connect: { id: userId } },
					item: { connect: { id: item.id } },
				},
				select: { id: true },
			});

			return ApiResponse(res, 200, { message: "Item is shared" });
		}

		await db.sharedItem.delete({
			where: {
				id: sharedItem.id,
				ownerId: req.userId,
				userId: userId,
				itemId: item.id,
			},
		});

		ApiResponse(res, 200, { message: "Item is unshared" });
	} catch (error) {
		next(error);
	}
}

export async function makeTrash(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findUnique({
			where: { id: itemId, isTrash: false, ownerId: req.userId },
			select: {
				id: true,
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		await db.item.update({
			where: { id: item.id },
			data: {
				isTrash: true,
			},
		});

		ApiResponse(res, 200, { message: "Item sent to trash" });
	} catch (error) {
		next(error);
	}
}

export async function restoreItem(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findUnique({
			where: { id: itemId, isTrash: true, ownerId: req.userId },
			select: {
				id: true,
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		await db.item.update({
			where: {
				id: item.id,
			},
			data: {
				isTrash: false,
			},
		});

		ApiResponse(res, 200, { message: "Item restored" });
	} catch (error) {
		next(error);
	}
}

export async function deleteItem(
	req: Request,
	res: Response,
	next: NextFunction
) {
	try {
		if (!req.userId) {
			throw new ApiError(401, "Unauthorized request");
		}

		const itemId = req.params.itemId;

		if (!itemId) {
			throw new ApiError(400, "ItemId is missing");
		}

		const item = await db.item.findUnique({
			where: { id: itemId, isTrash: true, ownerId: req.userId },
			select: {
				id: true,
				isFolder: true,
				media: true,
				_count: {
					select: {
						childrens: true,
					},
				},
			},
		});

		if (!item) {
			throw new ApiError(404, "Item not found");
		}

		const items = await db.item.findMany({
			where: {
				parentId: item.id,
				isFolder: false,
			},
			select: {
				media: true,
			},
		});

		if (!item.isFolder) {
			const storageRef = ref(storage, item.media!);
			storageRef.toString() && deleteObject(storageRef);
		}

		items.forEach((item) => {
			const storageRef = ref(storage, item.media!);
			storageRef.toString() && deleteObject(storageRef);
		});

		if (item.isFolder && item._count.childrens > 0) {
			await db.$transaction([
				db.item.deleteMany({
					where: { parentId: item.id },
				}),

				db.item.delete({
					where: { id: item.id },
				}),
			]);

			return ApiResponse(res, 200, { message: "File is deleted" });
		}

		await db.item.delete({
			where: { id: item.id },
		});

		ApiResponse(res, 200, { message: "File is deleted" });
	} catch (error) {
		next(error);
	}
}
