import { AST, NestedCollectionNode, FieldNode, M2ONode, O2MNode } from '../types/ast';
import { clone, cloneDeep, uniq, pick } from 'lodash';
import database from './index';
import SchemaInspector from 'knex-schema-inspector';
import { Query, Item } from '../types';
import { PayloadService } from '../services/payload';
import applyQuery from '../utils/apply-query';
import Knex, { QueryBuilder } from 'knex';
import { toArray } from '../utils/to-array';

type RunASTOptions = {
	query?: AST['query'];
	knex?: Knex;
	child?: boolean;
};

export default async function runAST(
	originalAST: AST | NestedCollectionNode,
	options?: RunASTOptions
): Promise<null | Item | Item[]> {
	const ast = cloneDeep(originalAST);

	const knex = options?.knex || database;

	if (ast.type === 'm2a') {
		const results: { [collection: string]: null | Item | Item[] } = {};

		for (const collection of ast.names) {
			results[collection] = await run(
				collection,
				ast.children[collection],
				ast.query[collection]
			);
		}

		return results;
	} else {
		return await run(ast.name, ast.children, options?.query || ast.query);
	}

	async function run(
		collection: string,
		children: (NestedCollectionNode | FieldNode)[],
		query: Query
	) {
		// Retrieve the database columns to select in the current AST
		const { columnsToSelect, primaryKeyField, nestedCollectionNodes } = await parseCurrentLevel(
			collection,
			children,
			knex
		);

		// The actual knex query builder instance. This is a promise that resolves with the raw items from the db
		const dbQuery = await getDBQuery(knex, collection, columnsToSelect, query, primaryKeyField);

		const rawItems: Item | Item[] = await dbQuery;

		if (!rawItems) return null;

		// Run the items through the special transforms
		const payloadService = new PayloadService(collection, { knex });
		let items: null | Item | Item[] = await payloadService.processValues('read', rawItems);

		if (!items || items.length === 0) return items;

		// Apply the `_in` filters to the nested collection batches
		const nestedNodes = applyParentFilters(nestedCollectionNodes, items);

		for (const nestedNode of nestedNodes) {
			let tempLimit: number | null = null;

			// Nested o2m-items are fetched from the db in a single query. This means that we're fetching
			// all nested items for all parent items at once. Because of this, we can't limit that query
			// to the "standard" item limit. Instead of _n_ nested items per parent item, it would mean
			// that there's _n_ items, which are then divided on the parent items. (no good)
			if (nestedNode.type === 'o2m' && typeof nestedNode.query.limit === 'number') {
				tempLimit = nestedNode.query.limit;
				nestedNode.query.limit = -1;
			}

			let nestedItems = await runAST(nestedNode, { knex, child: true });

			if (nestedItems) {
				// Merge all fetched nested records with the parent items

				items = mergeWithParentItems(nestedItems, items, nestedNode, tempLimit);
			}
		}

		// During the fetching of data, we have to inject a couple of required fields for the child nesting
		// to work (primary / foreign keys) even if they're not explicitly requested. After all fetching
		// and nesting is done, we parse through the output structure, and filter out all non-requested
		// fields
		if (options?.child !== true) {
			items = removeTemporaryFields(items, originalAST, primaryKeyField);
		}

		return items;
	}
}

async function parseCurrentLevel(
	collection: string,
	children: (NestedCollectionNode | FieldNode)[],
	knex: Knex
) {
	const schemaInspector = SchemaInspector(knex);

	const primaryKeyField = (await schemaInspector.primary(collection)) as string;

	const columnsInCollection = (await schemaInspector.columns(collection)).map(
		({ column }) => column
	);

	const columnsToSelect: string[] = [];
	const nestedCollectionNodes: NestedCollectionNode[] = [];

	for (const child of children) {
		if (child.type === 'field') {
			if (columnsInCollection.includes(child.name) || child.name === '*') {
				columnsToSelect.push(child.name);
			}

			continue;
		}

		if (!child.relation) continue;

		if (child.type === 'm2o') {
			columnsToSelect.push(child.relation.many_field);
		}

		if (child.type === 'm2a') {
			columnsToSelect.push(child.relation.many_field);
			columnsToSelect.push(child.relation.one_collection_field!);
		}

		nestedCollectionNodes.push(child);
	}

	/** Always fetch primary key in case there's a nested relation that needs it */
	if (columnsToSelect.includes(primaryKeyField) === false) {
		columnsToSelect.push(primaryKeyField);
	}

	return { columnsToSelect, nestedCollectionNodes, primaryKeyField };
}

async function getDBQuery(
	knex: Knex,
	table: string,
	columns: string[],
	query: Query,
	primaryKeyField: string
): Promise<QueryBuilder> {
	let dbQuery = knex.select(columns.map((column) => `${table}.${column}`)).from(table);

	const queryCopy = clone(query);

	queryCopy.limit = typeof queryCopy.limit === 'number' ? queryCopy.limit : 100;

	if (queryCopy.limit === -1) {
		delete queryCopy.limit;
	}

	query.sort = query.sort || [{ column: primaryKeyField, order: 'asc' }];

	await applyQuery(knex, table, dbQuery, queryCopy);

	return dbQuery;
}

function applyParentFilters(
	nestedCollectionNodes: NestedCollectionNode[],
	parentItem: Item | Item[]
) {
	const parentItems = toArray(parentItem);

	for (const nestedNode of nestedCollectionNodes) {
		if (!nestedNode.relation) continue;

		if (nestedNode.type === 'm2o') {
			nestedNode.query = {
				...nestedNode.query,
				filter: {
					...(nestedNode.query.filter || {}),
					[nestedNode.relation.one_primary!]: {
						_in: uniq(
							parentItems.map((res) => res[nestedNode.relation.many_field])
						).filter((id) => id),
					},
				},
			};
		} else if (nestedNode.type === 'o2m') {
			const relatedM2OisFetched = !!nestedNode.children.find((child) => {
				return child.type === 'field' && child.name === nestedNode.relation.many_field;
			});

			if (relatedM2OisFetched === false) {
				nestedNode.children.push({ type: 'field', name: nestedNode.relation.many_field });
			}

			nestedNode.query = {
				...nestedNode.query,
				filter: {
					...(nestedNode.query.filter || {}),
					[nestedNode.relation.many_field]: {
						_in: uniq(parentItems.map((res) => res[nestedNode.parentKey])).filter(
							(id) => id
						),
					},
				},
			};
		} else if (nestedNode.type === 'm2a') {
			const keysPerCollection: { [collection: string]: (string | number)[] } = {};

			for (const parentItem of parentItems) {
				const collection = parentItem[nestedNode.relation.one_collection_field!];
				if (!keysPerCollection[collection]) keysPerCollection[collection] = [];
				keysPerCollection[collection].push(parentItem[nestedNode.relation.many_field]);
			}

			for (const relatedCollection of nestedNode.names) {
				nestedNode.query[relatedCollection] = {
					...nestedNode.query[relatedCollection],
					filter: {
						_and: [
							nestedNode.query[relatedCollection].filter,
							{
								[nestedNode.relatedKey[relatedCollection]]: {
									_in: uniq(keysPerCollection[relatedCollection]),
								},
							},
						].filter((f) => f),
					},
				};
			}
		}
	}

	return nestedCollectionNodes;
}

function mergeWithParentItems(
	nestedItem: Item | Item[],
	parentItem: Item | Item[],
	nestedNode: NestedCollectionNode,
	o2mLimit?: number | null
) {
	const nestedItems = toArray(nestedItem);
	const parentItems = clone(toArray(parentItem));

	if (nestedNode.type === 'm2o') {
		for (const parentItem of parentItems) {
			const itemChild = nestedItems.find((nestedItem) => {
				return (
					nestedItem[nestedNode.relation.one_primary!] === parentItem[nestedNode.fieldKey]
				);
			});

			parentItem[nestedNode.fieldKey] = itemChild || null;
		}
	} else if (nestedNode.type === 'o2m') {
		for (const parentItem of parentItems) {
			let itemChildren = nestedItems.filter((nestedItem) => {
				if (nestedItem === null) return false;
				if (Array.isArray(nestedItem[nestedNode.relation.many_field])) return true;

				return (
					nestedItem[nestedNode.relation.many_field] ===
						parentItem[nestedNode.relation.one_primary!] ||
					nestedItem[nestedNode.relation.many_field]?.[
						nestedNode.relation.one_primary!
					] === parentItem[nestedNode.relation.one_primary!]
				);
			});

			// We re-apply the requested limit here. This forces the _n_ nested items per parent concept
			if (o2mLimit !== null) {
				itemChildren = itemChildren.slice(0, o2mLimit);
				nestedNode.query.limit = o2mLimit;
			}

			parentItem[nestedNode.fieldKey] = itemChildren.length > 0 ? itemChildren : null;
		}
	} else if (nestedNode.type === 'm2a') {
		for (const parentItem of parentItems) {
			const relatedCollection = parentItem[nestedNode.relation.one_collection_field!];

			const itemChild = (nestedItem as Record<string, any[]>)[relatedCollection].find(
				(nestedItem) => {
					return (
						nestedItem[nestedNode.relatedKey[relatedCollection]] ===
						parentItem[nestedNode.fieldKey]
					);
				}
			);

			parentItem[nestedNode.fieldKey] = itemChild || null;
		}
	}

	return Array.isArray(parentItem) ? parentItems : parentItems[0];
}

function removeTemporaryFields(
	rawItem: Item | Item[],
	ast: AST | NestedCollectionNode,
	primaryKeyField: string,
	parentItem?: Item
): null | Item | Item[] {
	const rawItems = cloneDeep(toArray(rawItem));
	const items: Item[] = [];

	if (ast.type === 'm2a') {
		const fields: Record<string, string[]> = {};
		const nestedCollectionNodes: Record<string, NestedCollectionNode[]> = {};

		for (const relatedCollection of ast.names) {
			if (!fields[relatedCollection]) fields[relatedCollection] = [];
			if (!nestedCollectionNodes[relatedCollection])
				nestedCollectionNodes[relatedCollection] = [];

			for (const child of ast.children[relatedCollection]) {
				if (child.type === 'field') {
					fields[relatedCollection].push(child.name);
				} else {
					fields[relatedCollection].push(child.fieldKey);
					nestedCollectionNodes[relatedCollection].push(child);
				}
			}
		}

		for (const rawItem of rawItems) {
			const relatedCollection: string = parentItem?.[ast.relation.one_collection_field!];

			if (rawItem === null || rawItem === undefined) return rawItem;

			let item = rawItem;

			for (const nestedNode of nestedCollectionNodes[relatedCollection]) {
				item[nestedNode.fieldKey] = removeTemporaryFields(
					item[nestedNode.fieldKey],
					nestedNode,
					nestedNode.relation.many_primary,
					item
				);
			}

			item =
				fields[relatedCollection].length > 0
					? pick(rawItem, fields[relatedCollection])
					: rawItem[primaryKeyField];

			items.push(item);
		}
	} else {
		const fields: string[] = [];
		const nestedCollectionNodes: NestedCollectionNode[] = [];

		for (const child of ast.children) {
			if (child.type === 'field') {
				fields.push(child.name);
			} else {
				fields.push(child.fieldKey);
				nestedCollectionNodes.push(child);
			}
		}

		for (const rawItem of rawItems) {
			if (rawItem === null || rawItem === undefined) return rawItem;

			let item = rawItem;

			for (const nestedNode of nestedCollectionNodes) {
				item[nestedNode.fieldKey] = removeTemporaryFields(
					item[nestedNode.fieldKey],
					nestedNode,
					nestedNode.type === 'm2o'
						? nestedNode.relation.one_primary!
						: nestedNode.relation.many_primary,
					item
				);
			}

			item = fields.length > 0 ? pick(rawItem, fields) : rawItem[primaryKeyField];

			items.push(item);
		}
	}

	return Array.isArray(rawItem) ? items : items[0];
}
