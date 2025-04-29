package main

import (
	"reflect"
	"testing"
)

func TestFixSrtFormatting(t *testing.T) {
	type tc struct {
		name     string
		input    string
		expected string
	}

	tests := []tc{
		{
			name: "well-formed input unchanged",
			input: `1
00:00:01,000 --> 00:00:02,000
Hello world

2
00:00:03,000 --> 00:00:04,000
Second caption`,
			expected: `1
00:00:01,000 --> 00:00:02,000
Hello world

2
00:00:03,000 --> 00:00:04,000
Second caption`,
		},
		{
			name: "enter on first line",
			input: `
1
00:00:01,000 --> 00:00:02,000
Hello world

2
00:00:03,000 --> 00:00:04,000
Second caption`,
			expected: `1
00:00:01,000 --> 00:00:02,000
Hello world

2
00:00:03,000 --> 00:00:04,000
Second caption`,
		},
		{
			name: "random blank lines in body",
			input: `1

00:00:01,000 --> 00:00:02,000

Hello

world


2

00:00:03,000 --> 00:00:04,000
Second

caption
`,
			expected: `1
00:00:01,000 --> 00:00:02,000
Hello
world

2
00:00:03,000 --> 00:00:04,000
Second
caption`,
		},
		{
			name: "missing blank line between blocks",
			input: `1
00:00:01,000 --> 00:00:02,000
First
2
00:00:03,000 --> 00:00:04,000
Second`,
			expected: `1
00:00:01,000 --> 00:00:02,000
First

2
00:00:03,000 --> 00:00:04,000
Second`,
		},
		{
			name: "duplicated segment numbers in input",
			input: `1
00:00:01,000 --> 00:00:02,000
Hello
2
2
00:00:02,000 --> 00:00:03,000
world
`,
			expected: `1
00:00:01,000 --> 00:00:02,000
Hello
2

2
00:00:02,000 --> 00:00:03,000
world`,
		},
		{
			name: "multi-line subtitle preserved",
			input: `1
00:00:01,000 --> 00:00:03,000
Line one
Line two
Line three`,
			expected: `1
00:00:01,000 --> 00:00:03,000
Line one
Line two
Line three`,
		},
		{
			name:  "leading/trailing spaces trimmed",
			input: "  1  \n  00:00:01,000 --> 00:00:02,000   \n  Text with spaces  ",
			expected: `1
00:00:01,000 --> 00:00:02,000
Text with spaces`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := fixSrtFormatting(test.input)
			if !reflect.DeepEqual(got, test.expected) {
				t.Errorf("fixSrtFormatting() =\n%q\nwant\n%q", got, test.expected)
			}
		})
	}
}
