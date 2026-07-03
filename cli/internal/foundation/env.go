package foundation

import (
	"os"
	"strings"
)

type Env map[string]string

func EnvFromOS() Env {
	env := Env{}
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			env[name] = value
		}
	}
	return env
}

func (e Env) Get(name string) string {
	return e[name]
}
