const pathPattern = '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000]+$';

const nonEmptyString = { type: 'string', minLength: 1 };

export const provenanceSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'producer',
    'builder',
    'distribution',
    'files',
    'dependencyReviews',
  ],
  properties: {
    schemaVersion: { const: 1 },
    producer: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version'],
      properties: {
        name: nonEmptyString,
        version: nonEmptyString,
      },
    },
    builder: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: nonEmptyString,
        version: { type: 'integer', minimum: 1 },
      },
    },
    distribution: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'visibility', 'publicPromotion'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
        visibility: { const: 'private' },
        publicPromotion: { const: 'blocked-until-explicit-review' },
      },
    },
    files: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'source',
          'target',
          'sourceCategory',
          'origin',
          'privateAuthority',
          'publicEligibility',
          'transformation',
          'expectedSha256',
          'mode',
          'capabilities',
        ],
        properties: {
          source: { type: 'string', pattern: pathPattern },
          target: { type: 'string', pattern: pathPattern },
          sourceCategory: {
            enum: [
              'producer-authored',
              'third-party',
              'private-derived',
              'generated',
            ],
          },
          origin: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'path'],
            properties: {
              type: { enum: ['repository', 'external'] },
              path: nonEmptyString,
            },
          },
          privateAuthority: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'scope', 'basis'],
            properties: {
              status: { const: 'authorized' },
              scope: { const: 'private-internal-use' },
              basis: nonEmptyString,
            },
          },
          publicEligibility: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'basis'],
            properties: {
              status: { enum: ['unknown', 'blocked', 'eligible'] },
              basis: nonEmptyString,
            },
          },
          transformation: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { const: 'identity' },
            },
          },
          expectedSha256: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
          },
          mode: {
            type: 'string',
            pattern: '^0[0-7]{3}$',
          },
          capabilities: {
            type: 'array',
            uniqueItems: true,
            items: { enum: ['execute'] },
          },
        },
      },
    },
    dependencyReviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'package',
          'version',
          'declaredLicense',
          'privateUseReview',
          'publicEligibility',
        ],
        properties: {
          package: nonEmptyString,
          version: nonEmptyString,
          declaredLicense: nonEmptyString,
          privateUseReview: { const: 'reviewed' },
          publicEligibility: {
            enum: ['unknown', 'blocked', 'eligible'],
          },
        },
      },
    },
  },
};
