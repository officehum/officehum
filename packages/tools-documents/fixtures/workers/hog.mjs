/** A parser that keeps every object it makes, until its thread runs out of heap. */

const kept = [];
for (;;) {
  kept.push(Array.from({ length: 100_000 }, (_, index) => ({ index })));
}
