// Command export-codex-metadata extracts original pure catalog metadata rules.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path"
	"sort"
	"strconv"
)

func main() {
	positions := token.NewFileSet()
	nodes := map[string]ast.Node{}
	imports := map[string]string{}
	for _, filename := range []string{"internal/service/openai_codex_model_metadata.go", "internal/service/openai_codex_models_service.go", "internal/service/upstream_models.go"} {
		file, err := parser.ParseFile(positions, filename, nil, 0)
		if err != nil {
			panic(err)
		}
		for _, spec := range file.Imports {
			value, _ := strconv.Unquote(spec.Path.Value)
			name := path.Base(value)
			if spec.Name != nil {
				name = spec.Name.Name
			}
			imports[name] = value
		}
		for _, declaration := range file.Decls {
			switch declaration := declaration.(type) {
			case *ast.FuncDecl:
				if declaration.Recv == nil {
					nodes[declaration.Name.Name] = declaration
				}
			case *ast.GenDecl:
				for _, spec := range declaration.Specs {
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						nodes[spec.Name.Name] = declaration
					case *ast.ValueSpec:
						for _, name := range spec.Names {
							nodes[name.Name] = declaration
						}
					}
				}
			}
		}
	}
	selected := map[ast.Node]bool{}
	var visit func(string)
	visit = func(name string) {
		node := nodes[name]
		if node == nil || selected[node] {
			return
		}
		selected[node] = true
		ast.Inspect(node, func(child ast.Node) bool {
			if identifier, ok := child.(*ast.Ident); ok {
				visit(identifier.Name)
			}
			return true
		})
	}
	for _, name := range []string{"intersectUpstreamModelMetadata", "applyUpstreamModelMetadataToCodexDescriptor", "applyCodexToolCapabilities"} {
		if nodes[name] == nil {
			panic("missing original metadata function: " + name)
		}
		visit(name)
	}
	ordered := []ast.Node{}
	packages := map[string]bool{}
	for node := range selected {
		ordered = append(ordered, node)
		ast.Inspect(node, func(child ast.Node) bool {
			if selector, ok := child.(*ast.SelectorExpr); ok {
				if identifier, ok := selector.X.(*ast.Ident); ok && imports[identifier.Name] != "" {
					packages[identifier.Name] = true
				}
			}
			return true
		})
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Pos() < ordered[j].Pos() })
	var output bytes.Buffer
	fmt.Fprintln(&output, "//go:build js && wasm\n\n// Code generated from original Sub2API catalog metadata; DO NOT EDIT.\npackage main\n\nimport (")
	names := []string{}
	for name := range packages {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(&output, "%s %q\n", name, imports[name])
	}
	fmt.Fprintln(&output, ")")
	for _, node := range ordered {
		fmt.Fprintln(&output)
		if err := format.Node(&output, positions, node); err != nil {
			panic(err)
		}
		fmt.Fprintln(&output)
	}
	formatted, err := format.Source(output.Bytes())
	if err != nil {
		panic(err)
	}
	if _, err := os.Stdout.Write(formatted); err != nil {
		panic(err)
	}
}
