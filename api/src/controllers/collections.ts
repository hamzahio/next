import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import { CollectionsService, MetaService } from '../services';
import { ForbiddenException, InvalidPayloadException } from '../exceptions';
import { respond } from '../middleware/respond';

const router = Router();

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const collectionsService = new CollectionsService({ accountability: req.accountability });

		const collectionKey = await collectionsService.create(req.body);
		const record = await collectionsService.readByKey(collectionKey);

		res.locals.payload = { data: record || null };
		return next();
	}),
	respond
);

router.get(
	'/',
	asyncHandler(async (req, res, next) => {
		const collectionsService = new CollectionsService({ accountability: req.accountability });
		const metaService = new MetaService({ accountability: req.accountability });

		const collections = await collectionsService.readByQuery();
		const meta = await metaService.getMetaForQuery('directus_collections', {});

		res.locals.payload = { data: collections || null, meta };
		return next();
	}),
	respond
);

router.get(
	'/:collection',
	asyncHandler(async (req, res, next) => {
		const collectionsService = new CollectionsService({ accountability: req.accountability });
		const collectionKey = req.params.collection.includes(',')
			? req.params.collection.split(',')
			: req.params.collection;

		try {
			const collection = await collectionsService.readByKey(collectionKey as any);
			res.locals.payload = { data: collection || null };
		} catch (error) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

router.patch(
	'/:collection',
	asyncHandler(async (req, res, next) => {
		const collectionsService = new CollectionsService({ accountability: req.accountability });
		const collectionKey = req.params.collection.includes(',')
			? req.params.collection.split(',')
			: req.params.collection;
		await collectionsService.update(req.body, collectionKey as any);

		try {
			const collection = await collectionsService.readByKey(collectionKey as any);
			res.locals.payload = { data: collection || null };
		} catch (error) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

router.delete(
	'/',
	asyncHandler(async (req, res, next) => {
		if (!req.body || Array.isArray(req.body) === false) {
			throw new InvalidPayloadException(`Body has to be an array of primary keys`);
		}

		const collectionsService = new CollectionsService({ accountability: req.accountability });
		await collectionsService.delete(req.body as string[]);

		return next();
	}),
	respond
);

router.delete(
	'/:collection',
	asyncHandler(async (req, res, next) => {
		const collectionsService = new CollectionsService({ accountability: req.accountability });
		const collectionKey = req.params.collection.includes(',')
			? req.params.collection.split(',')
			: req.params.collection;
		await collectionsService.delete(collectionKey as any);

		return next();
	}),
	respond
);

export default router;
