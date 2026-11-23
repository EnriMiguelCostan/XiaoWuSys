// ==========================================
// PRINT DETAILS (migration 015; pure rules: no HTTP, no SQL)
//
// What is printed on an order, apart from its materials (stock):
//   on a garment (an item marked "has sizes": shirts, jerseys...): size, name and number
//   on anything else (mugs, tarpaulins, stickers...): the text or name to print, and notes
// A line may belong to one material of the order (line_item_id). The pieces listed for a
// material can never be more than the order has of it ("20 shirts, 21 names" is refused).
// Before migration 015 these lines were order items without stock, which stopped both the quote
// and the approval. They are now kept on their own.
// ==========================================
// The sizes the shop really prints on (offered in the dropdown), smallest first
const GARMENT_SIZES = ['Kids S', 'Kids M', 'Kids L', 'Kids XL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'Free size'];
// Sizes from the first version of the list: still accepted, so lines saved with them can be edited
const LEGACY_SIZES = ['Kids 2', 'Kids 4', 'Kids 6', 'Kids 8', 'Kids 10', 'Kids 12', 'Kids 14', 'Kids 16', 'XXS', '4XL', '5XL', '6XL', '7XL'];
// How people write sizes in a roster (Excel / Google Sheets) -> the shop's size
const SIZE_ALIASES = {
  XXL: '2XL', XXXL: '3XL', XXXXL: '4XL', XXS: 'XXS',
  SMALL: 'S', MEDIUM: 'M', MED: 'M', LARGE: 'L', 'EXTRA SMALL': 'XS', 'EXTRA LARGE': 'XL',
  'X-SMALL': 'XS', 'X-LARGE': 'XL', 'XX-LARGE': '2XL', 'XXX-LARGE': '3XL',
  FREESIZE: 'Free size', 'FREE SIZE': 'Free size', FS: 'Free size', 'ONE SIZE': 'Free size',
  KS: 'Kids S', KM: 'Kids M', KL: 'Kids L', KXL: 'Kids XL',
  'KIDS SMALL': 'Kids S', 'KIDS MEDIUM': 'Kids M', 'KIDS LARGE': 'Kids L', 'KIDS EXTRA LARGE': 'Kids XL'
};
const KNOWN_SIZES = [...GARMENT_SIZES, ...LEGACY_SIZES];
// ' xl ' -> 'XL', 'xxl' -> '2XL', 'kids m' -> 'Kids M'; anything unknown is returned as written
const normalizeSize = (value) => {
  if (typeof value !== 'string') return value;
  const t = value.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const upper = t.toUpperCase();
  const exact = KNOWN_SIZES.find((k) => k.toUpperCase() === upper);
  if (exact) return exact;
  if (SIZE_ALIASES[upper]) return SIZE_ALIASES[upper];
  const kids = /^(?:KIDS?|K)[\s-]*(.+)$/.exec(upper);
  if (kids) {
    const inner = SIZE_ALIASES[kids[1]] || kids[1];
    const found = KNOWN_SIZES.find((k) => k.toUpperCase() === `KIDS ${String(inner).toUpperCase()}`);
    if (found) return found;
  }
  return t;
};
const PRINT_LIMITS = { print_type: 60, name: 50, number_digits: 3, quantity: 9999, notes: 500, bulk_rows: 500 };
const NAME_CHARS = /^[\p{L}\p{M}0-9 .'&,!?#/()-]*$/u; // names, and short texts on mugs ("Happy 50th!")
const GARMENT_NAME_CHARS = /^[\p{L}\p{M} .'-]*$/u;   // a name on a jersey: letters only (as before)

// One line as sent -> { errors: [{ field, message }], line }
//   material: the order's material it is for ({ line_item_id, quantity, has_sizes, item_name }) or null
const checkPrintLine = (raw, material, { prefix = '' } = {}) => {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const err = (field, message) => errors.push({ field, message: `${prefix}${message}` });
  const text = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v);
  const garment = Boolean(material && material.has_sizes);

  const print_type = text(r.print_type);
  if (!print_type) err('print_type', 'Write what is printed, like "Jersey print" or "Name on mug".');
  else if (typeof print_type !== 'string') err('print_type', 'What is printed must be written as text.');
  else if (print_type.length > PRINT_LIMITS.print_type) err('print_type', `Keep "what is printed" to ${PRINT_LIMITS.print_type} characters or fewer.`);

  const quantity = r.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > PRINT_LIMITS.quantity) {
    err('quantity', `Quantity must be a whole number from 1 to ${PRINT_LIMITS.quantity.toLocaleString()}.`);
  }

  const size = normalizeSize(text(r.size)) || null;
  if (size && !garment) {
    err('size', material
      ? `"${material.item_name}" is not a garment, so it has no sizes. Leave the size empty.`
      : 'Sizes are only for garments (shirts, jerseys...). Choose the garment this line is for, or leave the size empty.');
  } else if (size && !KNOWN_SIZES.includes(size)) err('size', `"${size}" is not a size we print. Choose one of: ${GARMENT_SIZES.join(', ')}.`);

  const custom_number = text(r.custom_number) || null;
  if (custom_number && !garment) err('custom_number', 'Numbers are for jerseys and other garments. Put it in the text instead.');
  else if (custom_number && !new RegExp(`^\\d{1,${PRINT_LIMITS.number_digits}}$`).test(custom_number)) err('custom_number', 'Numbers 0-999 only.');

  const custom_name = text(r.custom_name) || null;
  if (custom_name && custom_name.length > PRINT_LIMITS.name) err('custom_name', `Keep the name or text to ${PRINT_LIMITS.name} characters or fewer.`);
  else if (custom_name && !(garment ? GARMENT_NAME_CHARS : NAME_CHARS).test(custom_name)) {
    err('custom_name', garment
      ? 'A name on a garment may use letters, spaces, periods (.), hyphens (-) and apostrophes (’) only.'
      : 'The text may use letters, numbers, spaces and simple punctuation only.');
  }

  const notes = text(r.notes) || null;
  if (notes && notes.length > PRINT_LIMITS.notes) err('notes', `Keep the notes to ${PRINT_LIMITS.notes} characters or fewer.`);

  return {
    errors,
    line: {
      line_item_id: material ? material.line_item_id : null, print_type, quantity, size: garment ? size : null,
      custom_name, custom_number: garment ? custom_number : null, notes
    }
  };
};

// Pieces already listed per material, plus the new lines -> problems where they are more than the material's quantity
//   materials: [{ line_item_id, quantity, item_name }]; existing / added: [{ line_item_id, quantity, print_detail_id? }]
//   ignoreId: an existing line being edited (its old quantity does not count)
const overListed = (materials, existing, added, ignoreId = null) => {
  const problems = [];
  for (const m of materials) {
    const listed = existing.filter((p) => p.line_item_id === m.line_item_id && p.print_detail_id !== ignoreId)
      .reduce((s, p) => s + Number(p.quantity), 0)
      + added.filter((p) => p.line_item_id === m.line_item_id).reduce((s, p) => s + Number(p.quantity), 0);
    if (listed > m.quantity) problems.push({ line_item_id: m.line_item_id, item_name: m.item_name, listed, ordered: m.quantity });
  }
  return problems;
};

// Which material a line belongs to when the screen did not say: the order's only garment (sizes,
// numbers) or its only material. Several and none given: the whole order (null).
const defaultMaterialFor = (raw, materials) => {
  const wantsGarment = raw && (raw.size || raw.custom_number);
  const garments = materials.filter((m) => m.has_sizes);
  if (wantsGarment && garments.length === 1) return garments[0];
  if (materials.length === 1) return materials[0];
  return null;
};

module.exports = { GARMENT_SIZES, LEGACY_SIZES, normalizeSize, PRINT_LIMITS, checkPrintLine, overListed, defaultMaterialFor };
