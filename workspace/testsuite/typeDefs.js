module.exports = `
  scalar Date
  enum Gender { male female }
  enum BuildingType { home office business }

  input PersonInputMeta {
    notify: Boolean
  }

  type Person
    @model(key: "person", meta: "PersonInputMeta")
    @index(name: "uix_person_name", type: unique, on: [name])
  {
    age: Int @field(key: "my_age")
    name: String! @field(serialize: toLowerCase)
    roles: [Role!]! @field(default: [])
    gender: Gender! @field(default: male)
    authored: [Book] @link(by: author) @field(connection: true)
    emailAddress: String! @field(key: "email_address", validate: email)
    friends: [Person] @field(normalize: dedupe, validate: selfless, onDelete: cascade, connection: true)
    status: String @field(key: "state")
    state: String @field(key: "address_state")
    telephone: String @field(default: "###-###-####")
    network: String @field(instruct: networkID)
    manipulate: String
    section: Section
    sections: [Section!]
    multiLang: AutoGraphMixed
  }

  type Book
    @model
    @index(name: "uix_book", type: unique, on: [name, author])
  {
    name: String! @field(normalize: toTitleCase, validate: bookName)
    price: Float! @field(validate: bookPrice)
    author: Person! @field(restruct: immutable, onDelete: cascade)
    bestSeller: Boolean
    bids: [Float]
    chapters: [Chapter] @link(by: book)
  }

  type Chapter
    @model
    @index(name: "uix_chapter", type: unique, on: [name, book])
  {
    temp: String # To test sorting...
    name: String! @field(key: "chapter_name" normalize: toTitleCase)
    book: Book! @field(onDelete: restrict)
    pages: [Page] @link(by: chapter)
  }

  type Page
    @model
    @index(name: "uix_page", type: unique, on: [number, chapter])
  {
    number: Int!
    verbage: String
    chapter: Chapter!
  }

  type BookStore
    @model
    @index(name: "uix_bookstore", type: unique, on: [name])
  {
    name: String! @field(normalize: toTitleCase)
    location: String
    books: [Book] @field(onDelete: cascade)
    building: Building!
  }

  type Library
    @model
    @index(name: "uix_library", type: unique, on: [name])
    @index(name: "uix_library_bulding", type: unique, on: [building])
  {
    name: String! @field(normalize: toTitleCase)
    location: String,
    books: [Book] @field(onDelete: cascade)
    building: Building!
  }

  type Apartment
    @model
    @index(name: "uix_apartment", type: unique, on: [name])
    @index(name: "uix_apartment_bulding", type: unique, on: [building])
  {
    name: String! @field(normalize: toTitleCase)
    location: String
    building: Building!
  }

  type Building
  {
    year: Int @field(key: "year_built")
    type: BuildingType!
    tenants: [Person] @field(onDelete: cascade)
    landlord: Person @field(onDelete: nullify)
    description: String @field(default: "A building from the bloom")
  }

  type Color
    @model
  {
    type: String! @field(validate: colors)
    isDefault: Boolean
  }

  type Art
    @model
  {
    name: String! @field(normalize: toTitleCase)
    bids: [Float]
    comments: [String] @field(validate: artComment)
    sections: [Section]
  }

  type Section @model(embed: true) {
    name: String! @field(normalize: toLowerCase)
    frozen: String! @field(default: "frozen", restruct: immutable)
    type: BuildingType
    description: String
    mixed: AutoGraphMixed
    person: Person @field(onDelete: nullify)
    persons: [Person!] @field(onDelete: cascade)
  }

  type PlainJane @model {
    id: ID!
    name: String
    role: RoleEmbedded
    dependents: [Dependent!]
    roles: [Role!]! @field(default: [], fk: name, onDelete: cascade)
    data: AutoGraphMixed
  }

  type Dependent @model {
    jane: PlainJane! @field(onDelete: cascade) @link(by: dependents)
  }

  type Role @model {
    name: String!
  }

  type RoleEmbedded {
    detail: RoleDetail
  }

  type RoleDetail {
    scope: String
  }
`;
