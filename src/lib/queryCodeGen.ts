// Driver code generation for the "Query Code" tab: render the last-run query
// as a runnable program in each supported language. Every generator embeds the
// query as canonical Extended JSON and feeds it to that driver's EJSON parser
// (EJSON.parse / json_util.loads / Document.parse / BsonDocument.Parse /
// bson.UnmarshalExtJSON), so all BSON types survive in every language.
import { buildRunnableCommand, type GeneratedQuery } from './mongoCommand';

export interface QueryCodeSpec {
  db: string;
  collection: string;
  query: GeneratedQuery;
}

export const CODE_LANGUAGES = ['mongosh', 'Node.js', 'Python', 'Java', 'C#', 'Go'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

const URI = 'mongodb://host:port/';

const isEmptyDoc = (v: unknown): boolean =>
  v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

const ejson = (v: unknown): string => JSON.stringify(v ?? {});

// Escape for a Java/JS-style double-quoted string literal.
const dq = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// Escape for a C# verbatim string (@"..."): double the quotes.
const verbatim = (s: string): string => s.replace(/"/g, '""');
// Single-quoted literal for JS/Python.
const sq = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function nodeJs(spec: QueryCodeSpec): string {
  const { query } = spec;
  const lines: string[] = [
    "const { MongoClient } = require('mongodb');",
    "const { EJSON } = require('bson');",
    '',
    'async function run() {',
    `  const client = new MongoClient('${URI}');`,
    '  try {',
    `    const collection = client.db('${sq(spec.db)}').collection('${sq(spec.collection)}');`,
  ];
  if (query.queryType === 'aggregate') {
    lines.push(`    const pipeline = EJSON.parse('${sq(ejson(query.pipeline ?? []))}');`);
    lines.push('    const cursor = collection.aggregate(pipeline);');
  } else {
    lines.push(`    const filter = EJSON.parse('${sq(ejson(query.filter))}');`);
    let cursor = '    const cursor = collection.find(filter)';
    if (!isEmptyDoc(query.projection)) cursor += `\n      .project(EJSON.parse('${sq(ejson(query.projection))}'))`;
    if (!isEmptyDoc(query.sort)) cursor += `\n      .sort(EJSON.parse('${sq(ejson(query.sort))}'))`;
    if (query.skip) cursor += `\n      .skip(${query.skip})`;
    if (query.limit) cursor += `\n      .limit(${query.limit})`;
    lines.push(cursor + ';');
  }
  lines.push(
    '    for await (const doc of cursor) {',
    '      console.log(doc);',
    '    }',
    '  } finally {',
    '    await client.close();',
    '  }',
    '}',
    '',
    'run().catch(console.dir);',
  );
  return lines.join('\n');
}

function python(spec: QueryCodeSpec): string {
  const { query } = spec;
  const lines: string[] = [
    'from pymongo import MongoClient',
    'from bson.json_util import loads',
    '',
    `client = MongoClient('${URI}')`,
    `collection = client['${sq(spec.db)}']['${sq(spec.collection)}']`,
    '',
  ];
  if (query.queryType === 'aggregate') {
    lines.push(`pipeline = loads('${sq(ejson(query.pipeline ?? []))}')`);
    lines.push('cursor = collection.aggregate(pipeline)');
  } else {
    lines.push(`query_filter = loads('${sq(ejson(query.filter))}')`);
    let call = 'cursor = collection.find(query_filter';
    if (!isEmptyDoc(query.projection)) call += `, loads('${sq(ejson(query.projection))}')`;
    call += ')';
    if (!isEmptyDoc(query.sort)) call += `.sort(list(loads('${sq(ejson(query.sort))}').items()))`;
    if (query.skip) call += `.skip(${query.skip})`;
    if (query.limit) call += `.limit(${query.limit})`;
    lines.push(call);
  }
  lines.push('', 'for doc in cursor:', '    print(doc)');
  return lines.join('\n');
}

function java(spec: QueryCodeSpec): string {
  const { query } = spec;
  const isAgg = query.queryType === 'aggregate';
  const lines: string[] = [
    'import com.mongodb.client.MongoClient;',
    'import com.mongodb.client.MongoClients;',
    'import com.mongodb.client.MongoCollection;',
    'import org.bson.Document;',
  ];
  if (isAgg) lines.push('import java.util.Arrays;');
  lines.push(
    '',
    'public class MongoDBQuery {',
    '    public static void main(String[] args) {',
    `        try (MongoClient client = MongoClients.create("${URI}")) {`,
    '            MongoCollection<Document> collection = client',
    `                .getDatabase("${dq(spec.db)}")`,
    `                .getCollection("${dq(spec.collection)}");`,
    '',
  );
  if (isAgg) {
    const stages = (query.pipeline ?? [])
      .map((stage) => `Document.parse("${dq(JSON.stringify(stage))}")`)
      .join(',\n                ');
    lines.push(
      '            Iterable<Document> docs = collection.aggregate(Arrays.asList(',
      `                ${stages}`,
      '            ));',
    );
  } else {
    let chain = `            Iterable<Document> docs = collection.find(Document.parse("${dq(ejson(query.filter))}"))`;
    if (!isEmptyDoc(query.projection)) chain += `\n                .projection(Document.parse("${dq(ejson(query.projection))}"))`;
    if (!isEmptyDoc(query.sort)) chain += `\n                .sort(Document.parse("${dq(ejson(query.sort))}"))`;
    if (query.skip) chain += `\n                .skip(${query.skip})`;
    if (query.limit) chain += `\n                .limit(${query.limit})`;
    lines.push(chain + ';');
  }
  lines.push(
    '',
    '            for (Document doc : docs) {',
    '                System.out.println(doc.toJson());',
    '            }',
    '        }',
    '    }',
    '}',
  );
  return lines.join('\n');
}

function csharp(spec: QueryCodeSpec): string {
  const { query } = spec;
  const isAgg = query.queryType === 'aggregate';
  const lines: string[] = [
    'using MongoDB.Bson;',
    'using MongoDB.Driver;',
    'using System;',
    '',
    'class Program',
    '{',
    '    static void Main(string[] args)',
    '    {',
    `        var client = new MongoClient("${URI}");`,
    '        var collection = client',
    `            .GetDatabase("${dq(spec.db)}")`,
    `            .GetCollection<BsonDocument>("${dq(spec.collection)}");`,
    '',
  ];
  if (isAgg) {
    const stages = (query.pipeline ?? [])
      .map((stage) => `BsonDocument.Parse(@"${verbatim(JSON.stringify(stage))}")`)
      .join(',\n            ');
    lines.push(
      '        var pipeline = new[]',
      '        {',
      `            ${stages}`,
      '        };',
      '        var docs = collection.Aggregate<BsonDocument>(pipeline).ToList();',
    );
  } else {
    lines.push(`        var filter = BsonDocument.Parse(@"${verbatim(ejson(query.filter))}");`);
    let chain = '        var docs = collection.Find(filter)';
    if (!isEmptyDoc(query.projection)) chain += `\n            .Project(BsonDocument.Parse(@"${verbatim(ejson(query.projection))}"))`;
    if (!isEmptyDoc(query.sort)) chain += `\n            .Sort(BsonDocument.Parse(@"${verbatim(ejson(query.sort))}"))`;
    if (query.skip) chain += `\n            .Skip(${query.skip})`;
    if (query.limit) chain += `\n            .Limit(${query.limit})`;
    chain += '\n            .ToList();';
    lines.push(chain);
  }
  lines.push(
    '',
    '        foreach (var doc in docs)',
    '        {',
    '            Console.WriteLine(doc.ToJson());',
    '        }',
    '    }',
    '}',
  );
  return lines.join('\n');
}

function go(spec: QueryCodeSpec): string {
  const { query } = spec;
  const isAgg = query.queryType === 'aggregate';
  const lines: string[] = [
    'package main',
    '',
    'import (',
    '\t"context"',
    '\t"fmt"',
    '\t"log"',
    '',
    '\t"go.mongodb.org/mongo-driver/bson"',
    '\t"go.mongodb.org/mongo-driver/mongo"',
    '\t"go.mongodb.org/mongo-driver/mongo/options"',
    ')',
    '',
    'func main() {',
    '\tctx := context.Background()',
    `\tclient, err := mongo.Connect(ctx, options.Client().ApplyURI("${URI}"))`,
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tdefer client.Disconnect(ctx)',
    '',
    `\tcollection := client.Database("${dq(spec.db)}").Collection("${dq(spec.collection)}")`,
    '',
  ];
  if (isAgg) {
    lines.push(
      '\tvar pipeline []bson.D',
      `\tif err := bson.UnmarshalExtJSON([]byte(\`${ejson(query.pipeline ?? [])}\`), true, &pipeline); err != nil {`,
      '\t\tlog.Fatal(err)',
      '\t}',
      '\tcursor, err := collection.Aggregate(ctx, pipeline)',
    );
  } else {
    lines.push(
      '\tvar filter bson.D',
      `\tif err := bson.UnmarshalExtJSON([]byte(\`${ejson(query.filter)}\`), true, &filter); err != nil {`,
      '\t\tlog.Fatal(err)',
      '\t}',
    );
    const opts: string[] = [];
    if (!isEmptyDoc(query.projection)) {
      lines.push(
        '\tvar projection bson.D',
        `\tif err := bson.UnmarshalExtJSON([]byte(\`${ejson(query.projection)}\`), true, &projection); err != nil {`,
        '\t\tlog.Fatal(err)',
        '\t}',
      );
      opts.push('SetProjection(projection)');
    }
    if (!isEmptyDoc(query.sort)) {
      lines.push(
        '\tvar sort bson.D',
        `\tif err := bson.UnmarshalExtJSON([]byte(\`${ejson(query.sort)}\`), true, &sort); err != nil {`,
        '\t\tlog.Fatal(err)',
        '\t}',
      );
      opts.push('SetSort(sort)');
    }
    if (query.skip) opts.push(`SetSkip(${query.skip})`);
    if (query.limit) opts.push(`SetLimit(${query.limit})`);
    const optsExpr = opts.length ? `options.Find().${opts.join('.')}` : 'options.Find()';
    lines.push(`\tcursor, err := collection.Find(ctx, filter, ${optsExpr})`);
  }
  lines.push(
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tdefer cursor.Close(ctx)',
    '',
    '\tfor cursor.Next(ctx) {',
    '\t\tvar doc bson.M',
    '\t\tif err := cursor.Decode(&doc); err != nil {',
    '\t\t\tlog.Fatal(err)',
    '\t\t}',
    '\t\tfmt.Println(doc)',
    '\t}',
    '}',
  );
  return lines.join('\n');
}

export function generateQueryCode(lang: CodeLanguage, spec: QueryCodeSpec): string {
  switch (lang) {
    case 'mongosh': return buildRunnableCommand(spec.query, spec.collection);
    case 'Node.js': return nodeJs(spec);
    case 'Python': return python(spec);
    case 'Java': return java(spec);
    case 'C#': return csharp(spec);
    case 'Go': return go(spec);
  }
}
