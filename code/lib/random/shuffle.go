package random

import (
	"math/rand"
)

func Shuffle[T any](rng *rand.Rand, arr []T) {
	for i := range arr {
		j := rng.Intn(i + 1)
		arr[i], arr[j] = arr[j], arr[i]
	}
}
