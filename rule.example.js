const rule = {
  list: '/bookmarks/documents',
  // JSON schema
  schema: {
    type: 'object',
    properties: {
      foo: { type: 'string' },
      bar: { type: 'number' }
    },
    required: ['foo']
  },
  destination: '/bookmarks/services/target/tasks'
}
