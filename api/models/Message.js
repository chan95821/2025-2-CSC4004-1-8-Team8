const { z } = require('zod');
const Message = require('./schema/messageSchema');
const { logger } = require('~/config');

const idSchema = z.string().uuid();

/**
 * Saves a message in the database.
 *
 * @async
 * @function saveMessage
 * @param {Express.Request} req - The request object containing user information.
 * @param {Object} params - The message data object.
 * @param {string} params.endpoint - The endpoint where the message originated.
 * @param {string} params.iconURL - The URL of the sender's icon.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.newMessageId - The new unique identifier for the message (if applicable).
 * @param {string} params.conversationId - The identifier of the conversation.
 * @param {string} [params.parentMessageId] - The identifier of the parent message, if any.
 * @param {string} params.sender - The identifier of the sender.
 * @param {string} params.text - The text content of the message.
 * @param {boolean} params.isCreatedByUser - Indicates if the message was created by the user.
 * @param {string} [params.error] - Any error associated with the message.
 * @param {boolean} [params.unfinished] - Indicates if the message is unfinished.
 * @param {Object[]} [params.files] - An array of files associated with the message.
 * @param {boolean} [params.isEdited] - Indicates if the message was edited.
 * @param {string} [params.finish_reason] - Reason for finishing the message.
 * @param {number} [params.tokenCount] - The number of tokens in the message.
 * @param {string} [params.plugin] - Plugin associated with the message.
 * @param {string[]} [params.plugins] - An array of plugins associated with the message.
 * @param {string} [params.model] - The model used to generate the message.
 * @param {Array<{content: string}>} [params.atomic_ideas] - 아이디어 노드 배열 (messageSchema.nodes에 저장됨)
 * @param {Object} [metadata] - Additional metadata for this operation
 * @param {string} [metadata.context] - The context of the operation
* @returns {Promise<TMessage>} The updated or newly inserted message document.
 * @throws {Error} If there is an error in saving the message.
 */
async function saveMessage(req, params, metadata) {
  if (!req?.user?.id) {
    throw new Error('User not authenticated');
  }

  const validConvoId = idSchema.safeParse(params.conversationId);
  if (!validConvoId.success) {
    logger.warn(`Invalid conversation ID: ${params.conversationId}`);
    logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
    logger.info(`---Invalid conversation ID Params: ${JSON.stringify(params, null, 2)}`);
    return;
  }

  try {
    // Clean up params to remove undefined and null values that might cause schema issues
    const cleanedParams = Object.entries(params).reduce((acc, [key, value]) => {
      if (value !== undefined && value !== null && key !== 'atomic_ideas') {
        acc[key] = value;
      }
      return acc;
    }, {});

    const update = {
      ...cleanedParams,
      user: req.user.id,
      messageId: params.newMessageId || params.messageId,
    };

    // Convert atomic_ideas to nodes format if present
    if (params.atomic_ideas && Array.isArray(params.atomic_ideas)) {
      try {
        update.nodes = params.atomic_ideas.map((idea) => {
          if (typeof idea === 'object' && idea !== null && 'content' in idea) {
            return {
              content: idea.content,
              isCurated: false,
            };
          }
          // If idea is a string, wrap it
          return {
            content: String(idea),
            isCurated: false,
          };
        });
        logger.debug('[saveMessage] Converted atomic_ideas to nodes:', {
          count: update.nodes.length,
        });
      } catch (conversionErr) {
        logger.error('[saveMessage] Error converting atomic_ideas to nodes:', conversionErr);
        logger.warn('[saveMessage] atomic_ideas structure:', params.atomic_ideas);
        // Continue without nodes if conversion fails
      }
    }

    const message = await Message.findOneAndUpdate(
      { messageId: params.messageId, user: req.user.id },
      update,
      { upsert: true, new: true },
    );

    const messageObj = message.toObject();
    
    // Map MongoDB _id to id field for nodes
    if (messageObj.nodes && Array.isArray(messageObj.nodes)) {
      messageObj.nodes = messageObj.nodes.map((node) => ({
        ...node,
        id: node._id ? node._id.toString() : undefined,
      }));
    }

    return messageObj;
  } catch (err) {
    logger.error('Error saving message:', err);
    logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
    logger.warn('[saveMessage] Failed update params:', {
      messageId: params.messageId,
      hasAtomicIdeas: !!params.atomic_ideas,
      atomicIdeasLength: params.atomic_ideas?.length,
    });
    throw err;
  }
}

/**
 * Saves multiple messages in the database in bulk.
 *
 * @async
 * @function bulkSaveMessages
 * @param {Object[]} messages - An array of message objects to save.
 * @returns {Promise<Object>} The result of the bulk write operation.
 * @throws {Error} If there is an error in saving messages in bulk.
 */
async function bulkSaveMessages(messages) {
  try {
    const bulkOps = messages.map((message) => ({
      updateOne: {
        filter: { messageId: message.messageId },
        update: message,
        upsert: true,
      },
    }));

    const result = await Message.bulkWrite(bulkOps);
    return result;
  } catch (err) {
    logger.error('Error saving messages in bulk:', err);
    throw err;
  }
}

/**
 * Records a message in the database.
 *
 * @async
 * @function recordMessage
 * @param {Object} params - The message data object.
 * @param {string} params.user - The identifier of the user.
 * @param {string} params.endpoint - The endpoint where the message originated.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.conversationId - The identifier of the conversation.
 * @param {string} [params.parentMessageId] - The identifier of the parent message, if any.
 * @param {Partial<TMessage>} rest - Any additional properties from the TMessage typedef not explicitly listed.
 * @returns {Promise<Object>} The updated or newly inserted message document.
 * @throws {Error} If there is an error in saving the message.
 */
async function recordMessage({
  user,
  endpoint,
  messageId,
  conversationId,
  parentMessageId,
  ...rest
}) {
  try {
    // No parsing of convoId as may use threadId
    const message = {
      user,
      endpoint,
      messageId,
      conversationId,
      parentMessageId,
      ...rest,
    };

    return await Message.findOneAndUpdate({ user, messageId }, message, {
      upsert: true,
      new: true,
    });
  } catch (err) {
    logger.error('Error recording message:', err);
    throw err;
  }
}

/**
 * Updates the text of a message.
 *
 * @async
 * @function updateMessageText
 * @param {Object} params - The update data object.
 * @param {Object} req - The request object.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.text - The new text content of the message.
 * @returns {Promise<void>}
 * @throws {Error} If there is an error in updating the message text.
 */
async function updateMessageText(req, { messageId, text }) {
  try {
    await Message.updateOne({ messageId, user: req.user.id }, { text });
  } catch (err) {
    logger.error('Error updating message text:', err);
    throw err;
  }
}

/**
 * Updates a message.
 *
 * @async
 * @function updateMessage
 * @param {Object} req - The request object.
 * @param {Object} message - The message object containing update data.
 * @param {string} message.messageId - The unique identifier for the message.
 * @param {string} [message.text] - The new text content of the message.
 * @param {Object[]} [message.files] - The files associated with the message.
 * @param {boolean} [message.isCreatedByUser] - Indicates if the message was created by the user.
 * @param {string} [message.sender] - The identifier of the sender.
 * @param {number} [message.tokenCount] - The number of tokens in the message.
 * @param {Object} [metadata] - The operation metadata
 * @param {string} [metadata.context] - The operation metadata
 * @returns {Promise<TMessage>} The updated message document.
 * @throws {Error} If there is an error in updating the message or if the message is not found.
 */
async function updateMessage(req, message, metadata) {
  try {
    const { messageId, ...update } = message;
    update.isEdited = true;
    const updatedMessage = await Message.findOneAndUpdate(
      { messageId, user: req.user.id },
      update,
      {
        new: true,
      },
    );

    if (!updatedMessage) {
      throw new Error('Message not found or user not authorized.');
    }

    return {
      messageId: updatedMessage.messageId,
      conversationId: updatedMessage.conversationId,
      parentMessageId: updatedMessage.parentMessageId,
      sender: updatedMessage.sender,
      text: updatedMessage.text,
      isCreatedByUser: updatedMessage.isCreatedByUser,
      tokenCount: updatedMessage.tokenCount,
      isEdited: true,
    };
  } catch (err) {
    logger.error('Error updating message:', err);
    if (metadata && metadata?.context) {
      logger.info(`---\`updateMessage\` context: ${metadata.context}`);
    }
    throw err;
  }
}

/**
 * Deletes messages in a conversation since a specific message.
 *
 * @async
 * @function deleteMessagesSince
 * @param {Object} params - The parameters object.
 * @param {Object} req - The request object.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.conversationId - The identifier of the conversation.
 * @returns {Promise<Number>} The number of deleted messages.
 * @throws {Error} If there is an error in deleting messages.
 */
async function deleteMessagesSince(req, { messageId, conversationId }) {
  try {
    const message = await Message.findOne({ messageId, user: req.user.id }).lean();

    if (message) {
      const query = Message.find({ conversationId, user: req.user.id });
      return await query.deleteMany({
        createdAt: { $gt: message.createdAt },
      });
    }
    return undefined;
  } catch (err) {
    logger.error('Error deleting messages:', err);
    throw err;
  }
}

/**
 * Retrieves messages from the database.
 * @async
 * @function getMessages
 * @param {Record<string, unknown>} filter - The filter criteria.
 * @param {string | undefined} [select] - The fields to select.
 * @returns {Promise<TMessage[]>} The messages that match the filter criteria.
 * @throws {Error} If there is an error in retrieving messages.
 */
async function getMessages(filter, select) {
  try {
    let messages;
    if (select) {
      messages = await Message.find(filter).select(select).sort({ createdAt: 1 }).lean();
    } else {
      messages = await Message.find(filter).sort({ createdAt: 1 }).lean();
    }

    // Map MongoDB _id to id field for nodes in each message
    return messages.map((message) => {
      if (message.nodes && Array.isArray(message.nodes)) {
        message.nodes = message.nodes.map((node) => ({
          ...node,
          id: node._id ? node._id.toString() : undefined,
        }));
      }
      return message;
    });
  } catch (err) {
    logger.error('Error getting messages:', err);
    throw err;
  }
}

/**
 * Deletes messages from the database.
 *
 * @async
 * @function deleteMessages
 * @param {Object} filter - The filter criteria to find messages to delete.
 * @returns {Promise<Object>} The metadata with count of deleted messages.
 * @throws {Error} If there is an error in deleting messages.
 */
async function deleteMessages(filter) {
  try {
    return await Message.deleteMany(filter);
  } catch (err) {
    logger.error('Error deleting messages:', err);
    throw err;
  }
}

module.exports = {
  Message,
  saveMessage,
  bulkSaveMessages,
  recordMessage,
  updateMessageText,
  updateMessage,
  deleteMessagesSince,
  getMessages,
  deleteMessages,
};
