const adjectives = [
  'Happy', 'Clever', 'Swift', 'Brave', 'Calm', 'Eager', 'Gentle', 'Keen',
  'Lively', 'Noble', 'Quick', 'Warm', 'Bright', 'Bold', 'Cool', 'Fair'
]

const animals = [
  'Fox', 'Owl', 'Bear', 'Deer', 'Wolf', 'Hawk', 'Lynx', 'Seal',
  'Crane', 'Dove', 'Finch', 'Hare', 'Mink', 'Otter', 'Puma', 'Wren'
]

export function generateRandomName(): string {
  // A cosmetic display name for anonymous collaborators; not security-relevant.
  /* eslint-disable sonarjs/pseudo-random -- cosmetic choice, not security-relevant */
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)] ?? adjectives[0]
  const animal = animals[Math.floor(Math.random() * animals.length)] ?? animals[0]
  /* eslint-enable sonarjs/pseudo-random */
  return `${adj} ${animal}`
}
