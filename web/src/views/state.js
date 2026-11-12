import { CARDS, CARD_BY_ID, RULES, TIME_SLOTS } from "@moon/shared";

function spareCount(counts, id) {
  return Math.max((counts[CARD_BY_ID[id].no] ?? 0) - RULES.keep, 0);
}

export function toPosterState(listing) {
  if (!listing || !Array.isArray(listing.counts) || listing.counts.length !== CARDS.length) return null;
  const offer = CARDS
    .map((card) => ({ ...card, spare: spareCount(listing.counts, card.id) }))
    .filter((entry) => entry.spare > 0)
    .sort((a, b) => b.spare - a.spare);
  const want = (listing.want ?? [])
    .filter((id) => CARD_BY_ID[id])
    .map((id) => CARD_BY_ID[id]);
  const timeText = TIME_SLOTS.filter((slot) => (listing.timeSlots ?? []).includes(slot.id))
    .map((slot) => slot.label)
    .join("、");
  return {
    uid: listing.uid,
    nickname: listing.nickname ?? "旅行者",
    level: listing.level,
    serverLabel: listing.serverLabel ?? listing.serverGroup,
    offer,
    offerTotal: offer.reduce((sum, entry) => sum + entry.spare, 0),
    want,
    timeText: timeText || "未填写"
  };
}
