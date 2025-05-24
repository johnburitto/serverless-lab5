'use strict';

const yup = require('yup');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ORGANIZATIONS_TABLE = 'Organizations';
const USERS_TABLE = 'Users';

const client = new DynamoDBClient({
  region: 'eu-west-1',
  endpoint: 'http://0.0.0.0:8000',
  credentials: {
    accessKeyId: 'MockAccessKeyId',
    secretAccessKey: 'MockSecretAccessKey'
  }
});
const docClient = DynamoDBDocumentClient.from(client);

// ========= SCHEMAS =========
const postOrgSchema = yup.object({
  name: yup.string().trim().required(),
  description: yup.string().trim().required()
});

const postUserSchema = yup.object({
  name: yup.string().trim().required(),
  email: yup.string().email().trim().required(),
  organizationId: yup.string().required()
});

const putOrgSchema = yup.object({
  organizationId: yup.string().required(),
  name: yup.string().trim(),
  description: yup.string().trim()
});

const putUserSchema = yup.object({
  userId: yup.string().required(),
  name: yup.string().trim(),
  email: yup.string().email().trim(),
  organizationId: yup.string().required()
});

// ========= ENTRY POINT =========
module.exports.sqsHandler = async (event) => {
  try {
    for (const record of event.Records) {
      const { eventType, ...payload } = JSON.parse(record.body);
      switch (eventType) {
        case 'createOrganization':
          await createOrganization(payload);
          break;
        case 'createUser':
          await createUser(payload);
          break;
        case 'updateOrganization':
          await updateOrganization(payload);
          break;
        case 'updateUser':
          await updateUser(payload);
          break;
        default:
          console.warn('Unknown eventType:', eventType);
      }
    }
    return { statusCode: 200, body: JSON.stringify({ message: 'Processed' }) };
  } catch (err) {
    throw err;
  }
};

// ========= HANDLERS =========
async function createOrganization(data) {
  const org = validate(data, postOrgSchema);
  if (await isOrganizationExistsByName(org.name)) {
    throw new RequestException(400, `Organization '${org.name}' already exists`);
  }
  const item = { organizationId: uuidv4(), ...org };
  await executeCommand(PutCommand, { TableName: ORGANIZATIONS_TABLE, Item: item });
}

async function createUser(data) {
  const user = validate(data, postUserSchema);
  if (!(await isOrganizationExistsById(user.organizationId))) {
    throw new RequestException(400, `Organization ID '${user.organizationId}' not found`);
  }
  if (await isUserExistsByEmail(user.email)) {
    throw new RequestException(400, `User with email '${user.email}' already exists`);
  }
  const item = { userId: uuidv4(), ...user };
  await executeCommand(PutCommand, { TableName: USERS_TABLE, Item: item });
}

async function updateOrganization(data) {
  const org = validate(data, putOrgSchema);
  if (!(await isOrganizationExistsById(org.organizationId))) {
    throw new RequestException(404, `Organization ID '${org.organizationId}' not found`);
  }
  const updates = {};
  if (org.name) {
    if (await isOrganizationExistsByName(org.name)) {
      throw new RequestException(400, `Organization '${org.name}' already exists`);
    }
    updates.name = org.name;
  }
  if (org.description) updates.description = org.description;

  if (!Object.keys(updates).length) {
    throw new RequestException(400, 'No fields to update');
  }

  const params = getUpdateParams(updates);
  await executeCommand(UpdateCommand, {
    TableName: ORGANIZATIONS_TABLE,
    Key: { organizationId: org.organizationId },
    UpdateExpression: params.expression,
    ExpressionAttributeNames: params.names,
    ExpressionAttributeValues: params.values
  });
}

async function updateUser(data) {
  const user = validate(data, putUserSchema);
  const existing = await executeCommand(GetCommand, {
    TableName: USERS_TABLE,
    Key: { userId: user.userId }
  });
  if (!existing.Item) {
    throw new RequestException(404, `User ID '${user.userId}' not found`);
  }
  if (existing.Item.organizationId !== user.organizationId) {
    throw new RequestException(403, 'User does not belong to this organization');
  }

  const updates = {};
  if (user.name) updates.name = user.name;
  if (user.email) {
    updates.email = user.email;
    if (await isUserExistsByEmail(user.email, user.userId)) {
      throw new RequestException(400, `User with email '${user.email}' already exists`);
    }
  }

  if (!Object.keys(updates).length) {
    throw new RequestException(400, 'No fields to update');
  }

  const params = getUpdateParams(updates);
  await executeCommand(UpdateCommand, {
    TableName: USERS_TABLE,
    Key: { userId: user.userId },
    UpdateExpression: params.expression,
    ExpressionAttributeNames: params.names,
    ExpressionAttributeValues: params.values
  });
}

// ========= UTILS =========
function validate(obj, schema) {
  try {
    return schema.validateSync(obj, { abortEarly: false });
  } catch (err) {
    throw new RequestException(400, err.errors.join('; '));
  }
}

function executeCommand(CommandClass, params) {
  return docClient.send(new CommandClass(params));
}

function getUpdateParams(updates) {
  const names = {};
  const values = {};
  const keys = Object.keys(updates);
  const expression = 'SET ' + keys.map(k => {
    names['#' + k] = k;
    values[':' + k] = updates[k];
    return `#${k} = :${k}`;
  }).join(', ');
  return { expression, names, values };
}

async function isOrganizationExistsById(id) {
  const res = await executeCommand(GetCommand, {
    TableName: ORGANIZATIONS_TABLE,
    Key: { organizationId: id }
  });
  return !!res.Item;
}

async function isOrganizationExistsByName(name) {
  const res = await executeCommand(QueryCommand, {
    TableName: ORGANIZATIONS_TABLE,
    IndexName: 'name-index',
    KeyConditionExpression: '#n = :name',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':name': name }
  });
  return res.Items.length > 0;
}

async function isUserExistsByEmail(email, excludeId = null) {
  const res = await executeCommand(QueryCommand, {
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email }
  });
  return res.Items.some(u => u.userId !== excludeId);
}

class RequestException extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
