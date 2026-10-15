// Command export-gemini-compat extracts original pure converters for Edge WASM.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
)

func main() {
	path := "internal/service/gemini_messages_compat_service.go"
	source, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, path, source, 0)
	if err != nil {
		panic(err)
	}
	nodes := map[string]ast.Node{}
	usageSource, err := os.ReadFile("internal/service/gateway_service.go")
	if err != nil {
		panic(err)
	}
	usageFile, err := parser.ParseFile(positions, "internal/service/gateway_service.go", usageSource, 0)
	if err != nil {
		panic(err)
	}
	for _, declaration := range usageFile.Decls {
		if declaration, ok := declaration.(*ast.GenDecl); ok && declaration.Tok == token.TYPE {
			for _, spec := range declaration.Specs {
				if spec.(*ast.TypeSpec).Name.Name == "ClaudeUsage" {
					nodes["ClaudeUsage"] = declaration
				}
			}
		}
	}
	for _, declaration := range file.Decls {
		switch declaration := declaration.(type) {
		case *ast.FuncDecl:
			if declaration.Recv == nil {
				nodes[declaration.Name.Name] = declaration
			}
		case *ast.GenDecl:
			if declaration.Tok == token.CONST {
				for _, spec := range declaration.Specs {
					for _, name := range spec.(*ast.ValueSpec).Names {
						nodes[name.Name] = declaration
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
	for _, name := range []string{"convertClaudeMessagesToGeminiGenerateContent", "ensureGeminiFunctionCallThoughtSignatures", "normalizeGeminiRequestForAIStudio", "convertGeminiToClaudeMessage", "computeGeminiTextDelta", "extractGeminiParts"} {
		if nodes[name] == nil {
			panic("missing original Gemini converter: " + name)
		}
		visit(name)
	}
	var ordered []ast.Node
	packages := map[string]bool{}
	for node := range selected {
		ordered = append(ordered, node)
		ast.Inspect(node, func(child ast.Node) bool {
			if selector, ok := child.(*ast.SelectorExpr); ok {
				if identifier, ok := selector.X.(*ast.Ident); ok {
					packages[identifier.Name] = true
				}
			}
			return true
		})
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Pos() < ordered[j].Pos() })
	var output bytes.Buffer
	fmt.Fprintln(&output, "//go:build js && wasm\n\n// Code generated from original Sub2API Gemini converters; DO NOT EDIT.\npackage main\n\nimport (")
	for _, spec := range file.Imports {
		path, _ := strconv.Unquote(spec.Path.Value)
		name := path
		for i := len(name) - 1; i >= 0; i-- {
			if name[i] == '/' {
				name = name[i+1:]
				break
			}
		}
		if spec.Name != nil {
			name = spec.Name.Name
		}
		if packages[name] {
			fmt.Fprintf(&output, "%s\n", source[positions.Position(spec.Pos()).Offset:positions.Position(spec.End()).Offset])
		}
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
