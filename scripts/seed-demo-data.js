const dbName = 'mqlens_demo';
const db = db.getSiblingDB(dbName);

db.dropDatabase();

const regions = ['North America', 'Europe', 'APAC', 'Latin America'];
const statuses = ['new', 'processing', 'shipped', 'delivered', 'returned'];
const products = [
  { sku: 'MQL-STARTER', name: 'Starter Analytics Pack', category: 'Analytics', price: 49 },
  { sku: 'MQL-PRO', name: 'Pro Observability Pack', category: 'Observability', price: 149 },
  { sku: 'MQL-SEC', name: 'Security Audit Add-on', category: 'Security', price: 199 },
  { sku: 'MQL-OPS', name: 'Operations Dashboard', category: 'Operations', price: 99 },
  { sku: 'MQL-AI', name: 'AI Query Assistant', category: 'AI', price: 129 },
];

db.products.insertMany(products.map((product, index) => ({
  ...product,
  stock: 80 + index * 23,
  rating: Number((4.2 + index * 0.13).toFixed(2)),
  active: true,
  updatedAt: new Date(Date.UTC(2026, 4, 20 + index)),
})));

const customers = Array.from({ length: 36 }, (_, index) => {
  const region = regions[index % regions.length];
  const plan = ['Free', 'Team', 'Business', 'Enterprise'][index % 4];
  return {
    customerId: `CUS-${String(index + 1).padStart(4, '0')}`,
    name: [
      'Acme Data', 'Northstar Labs', 'Blue River Retail', 'Orbit Systems',
      'Signal Forge', 'Atlas Field Co', 'MetricWorks', 'BrightCart',
    ][index % 8] + ` ${index + 1}`,
    email: `buyer${index + 1}@example.com`,
    region,
    plan,
    lifecycle: index % 9 === 0 ? 'at_risk' : index % 5 === 0 ? 'expansion' : 'healthy',
    seats: 3 + (index % 12),
    spendToDate: 1200 + index * 215,
    tags: [region.toLowerCase().replaceAll(' ', '-'), plan.toLowerCase()],
    createdAt: new Date(Date.UTC(2025, index % 12, 4 + (index % 20))),
  };
});
db.customers.insertMany(customers);

const productDocs = db.products.find().toArray();
const orders = Array.from({ length: 180 }, (_, index) => {
  const customer = customers[index % customers.length];
  const itemCount = 1 + (index % 4);
  const items = Array.from({ length: itemCount }, (_, itemIndex) => {
    const product = productDocs[(index + itemIndex) % productDocs.length];
    const quantity = 1 + ((index + itemIndex) % 3);
    return {
      sku: product.sku,
      name: product.name,
      quantity,
      unitPrice: product.price,
      lineTotal: quantity * product.price,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = index % 7 === 0 ? 25 : index % 11 === 0 ? 50 : 0;
  const total = subtotal - discount;
  const createdAt = new Date(Date.UTC(2026, index % 6, 1 + (index % 27), 9 + (index % 8), 15));
  const status = statuses[index % statuses.length];
  return {
    orderNo: `ORD-${String(10000 + index)}`,
    customerId: customer.customerId,
    customerName: customer.name,
    region: customer.region,
    status,
    channel: ['web', 'sales-led', 'partner', 'marketplace'][index % 4],
    priority: index % 13 === 0 ? 'high' : 'normal',
    items,
    subtotal,
    discount,
    total,
    currency: 'USD',
    paid: !['new', 'returned'].includes(status),
    shipping: {
      carrier: ['DHL', 'UPS', 'FedEx', 'Local Courier'][index % 4],
      city: ['Berlin', 'Austin', 'Toronto', 'Singapore', 'Sao Paulo'][index % 5],
      etaDays: 2 + (index % 5),
    },
    createdAt,
    updatedAt: new Date(createdAt.getTime() + 1000 * 60 * 60 * (6 + (index % 48))),
  };
});
db.orders.insertMany(orders);

const events = Array.from({ length: 260 }, (_, index) => ({
  eventId: `EVT-${String(index + 1).padStart(5, '0')}`,
  type: ['query.run', 'connection.open', 'export.completed', 'index.created', 'schema.sampled'][index % 5],
  severity: index % 17 === 0 ? 'warning' : 'info',
  user: `analyst${(index % 9) + 1}@example.com`,
  database: dbName,
  collection: ['orders', 'customers', 'products'][index % 3],
  durationMs: 12 + ((index * 37) % 900),
  createdAt: new Date(Date.UTC(2026, 5, 1 + (index % 3), index % 24, (index * 7) % 60)),
  metadata: {
    source: ['desktop', 'shell', 'assistant'][index % 3],
    rowsReturned: (index * 13) % 500,
  },
}));
db.events.insertMany(events);

db.orders.createIndex({ status: 1, createdAt: -1 });
db.orders.createIndex({ region: 1, total: -1 });
db.orders.createIndex({ customerId: 1 });
db.customers.createIndex({ email: 1 }, { unique: true });
db.events.createIndex({ type: 1, createdAt: -1 });

db.createCollection('active_customer_revenue', {
  viewOn: 'orders',
  pipeline: [
    { $match: { status: { $in: ['shipped', 'delivered'] } } },
    { $group: { _id: '$region', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
  ],
});

db.fs.files.insertMany([
  {
    _id: ObjectId(),
    filename: 'orders-q2-export.csv',
    length: NumberLong('184320'),
    chunkSize: 261120,
    uploadDate: new Date(Date.UTC(2026, 5, 1, 10, 30)),
    contentType: 'text/csv',
    metadata: { owner: 'analytics', source: 'scheduled-export' },
  },
  {
    _id: ObjectId(),
    filename: 'customer-schema-snapshot.json',
    length: NumberLong('32768'),
    chunkSize: 261120,
    uploadDate: new Date(Date.UTC(2026, 5, 2, 14, 15)),
    contentType: 'application/json',
    metadata: { owner: 'data-platform', source: 'schema-analysis' },
  },
]);

printjson({
  database: dbName,
  products: db.products.countDocuments(),
  customers: db.customers.countDocuments(),
  orders: db.orders.countDocuments(),
  events: db.events.countDocuments(),
  gridFsFiles: db.fs.files.countDocuments(),
});
