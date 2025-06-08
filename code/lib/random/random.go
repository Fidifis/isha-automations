package random

import (
	"math/rand"
	"time"
)

func NewRandom() *rand.Rand {
	return rand.New(rand.NewSource(time.Now().UnixNano()))
}
