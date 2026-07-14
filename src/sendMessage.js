const axios = require("axios");
require("dotenv").config();

/**
 * Sends an outbound WhatsApp message via the Meta Cloud API.
 * Throws on non-2xx responses — callers should handle appropriately.
 */
/**
 * Sends an outbound WhatsApp message via the Meta Cloud API.
 * Supports both plain text and Message Templates.
 * 
 * @param {string} phone - Recipient phone number with country code.
 * @param {string} message - Plain text message OR variable content for template {{1}}
 * @param {object} [options] - Optional settings for template-based sending.
 * @param {string} [options.templateName] - Name of the pre-approved Meta template.
 * @param {string} [options.languageCode='en_US'] - Language code for the template.
 */
async function sendWhatsAppMessage(phone, message, options = {}) {
  const { templateName, languageCode = "en_US" } = options;

  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  let payload;

  if (templateName) {
    // Message Template Payload (bypasses 24h window)
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: message }
            ]
          }
        ]
      }
    };
  } else {
    // Standard Plain Text Payload (requires 24h window)
    payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    };
  }

  await axios.post(url, payload, { headers });
}

// Meta's error code when a free-form (non-template) message is rejected
// because the 24h customer-service window with that recipient is closed —
// either it expired, or (for a brand-new third-party recipient) it never
// opened in the first place.
const WINDOW_CLOSED_ERROR_CODE = 131047;

/**
 * Sends a message, automatically falling back to the approved Message
 * Template if Meta rejects the free-form text because the 24h window is
 * closed. Use this instead of sendWhatsAppMessage directly for:
 *   - Reminders/routines/recurring tasks dispatched by the scheduler
 *     (the owner may not have messaged Kael in the last 24h)
 *   - The "instant_message" intent when sending to a third-party contact
 *     (that contact may never have messaged Kael at all)
 *
 * Requires WHATSAPP_TEMPLATE_NAME to be set (a Meta-approved template with
 * a single {{1}} body variable). If it isn't set, this just rethrows the
 * original error — same behavior as calling sendWhatsAppMessage directly.
 */
async function sendWithTemplateFallback(phone, message) {
  try {
    await sendWhatsAppMessage(phone, message);
  } catch (err) {
    const errorCode = err.response?.data?.error?.code;
    const templateName = process.env.WHATSAPP_TEMPLATE_NAME;

    if (errorCode === WINDOW_CLOSED_ERROR_CODE && templateName) {
      await sendWhatsAppMessage(phone, message, {
        templateName,
        languageCode: process.env.WHATSAPP_TEMPLATE_LANG || "es_AR",
      });
      return;
    }

    throw err;
  }
}

module.exports = sendWhatsAppMessage;
module.exports.sendWhatsAppMessage = sendWhatsAppMessage;
module.exports.sendWithTemplateFallback = sendWithTemplateFallback;