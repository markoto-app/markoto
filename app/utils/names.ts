const adjectives = [
  'Happy', 'Clever', 'Swift', 'Brave', 'Calm', 'Eager', 'Gentle', 'Keen',
  'Lively', 'Noble', 'Quick', 'Warm', 'Bright', 'Bold', 'Cool', 'Fair'
]

const animals = [
  'Fox', 'Owl', 'Bear', 'Deer', 'Wolf', 'Hawk', 'Lynx', 'Seal',
  'Crane', 'Dove', 'Finch', 'Hare', 'Mink', 'Otter', 'Puma', 'Wren'
]

export function generateRandomName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const animal = animals[Math.floor(Math.random() * animals.length)]
  return `${adj} ${animal}`
}
