'use strict';

const yup = require('yup');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const postOrgSchema = yup.object({
  name: yup.string().trim().required('Organization name is required filed!'),
  description: yup.string().trim().required('Organization description is required filed!')
});

const postUserSchema = yup.object({
  name: yup.string().trim().required('User name is required field!'),
  email: yup.string().email('User email is invalid!').trim().required('User email is required field!'),
});

const putOrgSchema = yup.object({
  organizationId: yup.string().required("Organization id is required!"),
  name: yup.string().trim(),
  description: yup.string().trim()
});

const putUserSchema = yup.object({
  userId: yup.string().required('User id is required!'),
  name: yup.string().trim(),
  email: yup.string().email('User email is invalid!').trim()
});

const ORGANIZATIONS_TABLE = 'Organizations';
const USERS_TABLE = 'Users';

const client = new DynamoDBClient({
  region: 'eu-west-1',
  endpoint: 'http://0.0.0.0:8000',
  credentials: {
    accessKeyId: 'MockAccessKeyId',
    secretAccessKey: 'MockSecretAccessKey'
  },
});
const docClient = DynamoDBDocumentClient.from(client);

module.exports.createOrganization = async (event) => {
  try {
    let body = getBody(event);
    let organization = validate(body, postOrgSchema);

    if (await isOrganizationExistsByName(organization.name)) {
      throw new RequestException(400, `Organization with name '${organization.name}' already exists!`);
    }

    let item = { 
      organizationId: uuidv4(), 
      ...organization
    };

    await executeCommand(PutCommand, {
      TableName: ORGANIZATIONS_TABLE,
      Item: item
    });

    return getResponseObject(201, item);
  }
  catch (error) {
    return handleError(error);
  }
};

module.exports.createUser = async (event) => {
  try {
    const organizationId = event.pathParameters.organizationId;

    if (!(await isOrganizationExistsById(organizationId))) {
      throw new RequestException(400, `Organization with id '${organizationId}' not found!`);
    }

    let body = getBody(event);
    let user = validate(body, postUserSchema);

    if (await isUserExistsByEmail(user.email)) {
      throw new RequestException(400, `User with email '${user.email}' already exists!`);
    }

    let item = { 
      userId: uuidv4(),
      organizationId,
      ...user
    };

    await executeCommand(PutCommand, {
      TableName: USERS_TABLE,
      Item: item
    });

    return getResponseObject(201, item);
  }
  catch (error) {
    return handleError(error);
  }
};

module.exports.updateOrganization = async (event) => {
  try {
    let body = getBody(event);
    let organization = validate(body, putOrgSchema);

    if (!(await isOrganizationExistsById(organization.organizationId))) {
      throw new RequestException(404, `Organization with id '${organization.organizationId}' not found!`);
    }

    let updates = {};
    if (organization.name !== undefined) {
      updates.name = organization.name;
      
      if (await isOrganizationExistsByName(organization.name)) {
        throw new RequestException(400, `Organization with name '${organization.name}' already exists!`);
      }
    }

    if (organization.description !== undefined) {
      updates.description = organization.description;
    }

    if (Object.keys(updates).length === 0) {
      throw new RequestException(400, 'At least one of name or description must be provided');
    }

    let params = getUpdateParams(updates);

    let result = await executeCommand(UpdateCommand, {
      TableName: ORGANIZATIONS_TABLE,
      Key: {
        organizationId: organization.organizationId
      },
      UpdateExpression: params.expression,
      ExpressionAttributeNames: params.attributesNames,
      ExpressionAttributeValues: params.attributesValues,
      ReturnValues: 'ALL_NEW'
    });

    return getResponseObject(200, result.Attributes);
  }
  catch (error) {
    return handleError(error);
  }
};

module.exports.updateUser = async (event) => {
  try {
    const organizationId = event.pathParameters.organizationId;
    const body = getBody(event);
    const user = validate(body, putUserSchema);

    if (!(await isOrganizationExistsById(organizationId))) {
      throw new RequestException(400, `Organization with id '${organization.organizationId}' not found!`);
    }

    const getResult = await executeCommand(GetCommand, {
      TableName: USERS_TABLE,
      Key: { userId: user.userId }
    });

    if (!getResult.Item) {
      throw new RequestException(404, `User id '${getResult.Item.userId}' not found`);
    }

    if (getResult.Item.organizationId !== organizationId) {
      throw new RequestException(403, 'User does not belong to the specified organization');
    }

    let updates = {};
    if (user.name !== undefined) updates.name = user.name;
    if (user.email !== undefined) {
      updates.email = user.email;
      if (await isUserExistsByEmail(user.email, user.userId)) {
        throw new RequestException(400, `User with email ${user.email} already exists`);
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new RequestException(400, 'At least one of name or email must be provided');
    }

    let params = getUpdateParams(updates);

    const result = await executeCommand(UpdateCommand, {
      TableName: USERS_TABLE,
      Key: {
        userId: user.userId
      },
      UpdateExpression: params.expression,
      ExpressionAttributeNames: params.attributesNames,
      ExpressionAttributeValues: params.attributesValues,
      ReturnValues: 'ALL_NEW'
    });

    return getResponseObject(200, result.Attributes);
  }
  catch (error) {
    return handleError(error);
  }
};

function getResponseObject(code, body) {
  return {
    statusCode: code,
    body: JSON.stringify(body)
  };
}

function getBody(event) {
  try {
    return JSON.parse(event.body);
  }
  catch (error) {
    throw new RequestException(400, "Invalid Json body");
  }
}

function validate(obj, schema) {
  try {
    return schema.validateSync(obj, 
      { 
        abortEarly: false,
        strict: true
      });
  } catch (error) {
    throw new RequestException(400, error.errors.join(" "));
  }
}

function handleError(error) {
  if (error instanceof RequestException) {
    return getResponseObject(error.code,
      {
        message: error.message
      });
  }
  console.log(error);

  return getResponseObject(500, { message: error.message });
}

function executeCommand(CommandClass, params) {
  return docClient.send(new CommandClass(params));
}

async function isOrganizationExistsByName(nameValue) {
  const queryResult = await executeCommand(QueryCommand, {
    TableName: ORGANIZATIONS_TABLE,
    IndexName: 'name-index',
    KeyConditionExpression: '#n = :name',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':name': nameValue }
  });
  
  return queryResult.Items.length > 0;
}

async function isUserExistsByEmail(email, excludeUserId = null) {
  const result = await executeCommand(QueryCommand, {
    TableName: USERS_TABLE,
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email }
  });
  
  return result.Items.some(user => user.userId !== excludeUserId);
}

async function isOrganizationExistsById(organizationId) {
  let result = await executeCommand(GetCommand, {
    TableName: ORGANIZATIONS_TABLE,
    Key: { organizationId }
  });

  return !!result.Item;
}

function getUpdateParams(updates) {
  let expression = 'SET ' + Object.keys(updates).map(key => `#${key} = :${key}`).join(', ');
  let attributesNames = {};
  let attributesValues = {};
  Object.keys(updates).forEach(key => {
    attributesNames[`#${key}`] = key;
    attributesValues[`:${key}`] = updates[key];
  });

  return { expression, attributesNames, attributesValues };
}

class RequestException extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}