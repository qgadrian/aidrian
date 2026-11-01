---
type: regex
name: reports that refunding order.total to the card refunds the store credit twice
pattern: '^(?![^\n]*\bno (?:double|over))(?=[^\n]*(?:order\.total|totalCents|whole (?:order|price|total|amount)|full (?:order|price|total|amount)))(?=[^\n]*credit)(?=[^\n]*(?:twice|double[- ]?(?:refund|count|credit|pay)|over-?refund|exceed|more than (?:the|what|it)|too much|- *(?:order\.)?creditUsed|order\.total\b[^\n]{0,40}\binclud|\bincludes? (?:the )?(?:store[- ])?credit))'
flags: im
---
