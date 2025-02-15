import storage from '../storage';
import sharp, { ResizeOptions } from 'sharp';
import database from '../database';
import path from 'path';
import Knex from 'knex';
import { Accountability, AbstractServiceOptions, Transformation } from '../types';
import { AuthorizationService } from './authorization';

export class AssetsService {
	knex: Knex;
	accountability: Accountability | null;
	authorizationService: AuthorizationService;

	constructor(options?: AbstractServiceOptions) {
		this.knex = options?.knex || database;
		this.accountability = options?.accountability || null;
		this.authorizationService = new AuthorizationService(options);
	}

	async getAsset(id: string, transformation: Transformation) {
		const systemPublicKeys = Object.values(
			await this.knex
				.select('project_logo', 'public_background', 'public_foreground')
				.from('directus_settings')
				.first()
		);

		if (systemPublicKeys.includes(id) === false && this.accountability?.admin !== true) {
			await this.authorizationService.checkAccess('read', 'directus_files', id);
		}

		const file = await database.select('*').from('directus_files').where({ id }).first();

		const type = file.type;

		// We can only transform JPEG, PNG, and WebP
		if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
			const resizeOptions = this.parseTransformation(transformation);
			const assetFilename =
				path.basename(file.filename_disk, path.extname(file.filename_disk)) +
				this.getAssetSuffix(resizeOptions) +
				path.extname(file.filename_disk);

			const { exists } = await storage.disk(file.storage).exists(assetFilename);

			if (exists) {
				return { stream: storage.disk(file.storage).getStream(assetFilename), file };
			}

			const readStream = storage.disk(file.storage).getStream(file.filename_disk);
			const transformer = sharp().resize(resizeOptions);

			await storage.disk(file.storage).put(assetFilename, readStream.pipe(transformer));

			return { stream: storage.disk(file.storage).getStream(assetFilename), file };
		} else {
			const readStream = storage.disk(file.storage).getStream(file.filename_disk);
			return { stream: readStream, file };
		}
	}

	private parseTransformation(transformation: Transformation): ResizeOptions {
		const resizeOptions: ResizeOptions = {};

		if (transformation.width) resizeOptions.width = Number(transformation.width);
		if (transformation.height) resizeOptions.height = Number(transformation.height);
		if (transformation.fit) resizeOptions.fit = transformation.fit;
		if (transformation.withoutEnlargement)
			resizeOptions.withoutEnlargement = Boolean(transformation.withoutEnlargement);

		return resizeOptions;
	}

	private getAssetSuffix(resizeOptions: ResizeOptions) {
		if (Object.keys(resizeOptions).length === 0) return '';

		return (
			'__' +
			Object.entries(resizeOptions)
				.sort((a, b) => (a[0] > b[0] ? 1 : -1))
				.map((e) => e.join('_'))
				.join(',')
		);
	}
}
